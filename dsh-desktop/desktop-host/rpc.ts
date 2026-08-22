/**
 * desktop-host/rpc.ts — shell-neutral stdio RPC.
 *
 * Wire format:
 *   [4-byte little-endian byte length][UTF-8 JSON]
 *
 * stdout belongs exclusively to protocol frames. Callers must send logs to
 * stderr or the existing desktop log.
 */

import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import {
  DESKTOP_HOST_DEFAULT_TIMEOUT_MS,
  DESKTOP_HOST_MAX_FRAME_BYTES,
  DESKTOP_HOST_PROTOCOL_VERSION,
} from '../shared/contract/desktop-host.js';
import type {
  DesktopHostCancel,
  DesktopHostEvent,
  DesktopHostMessage,
  DesktopHostRequest,
  DesktopHostResponse,
} from '../shared/contract/desktop-host.js';
import type { DesktopError } from '../shared/contract/errors.js';

export interface DesktopHostRequestContext {
  readonly id: string;
  readonly signal: AbortSignal;
}

export type DesktopHostHandler = (
  params: unknown,
  context?: DesktopHostRequestContext,
) => Promise<unknown> | unknown;

export interface DesktopHostRpcOptions {
  readonly write: Writable;
  readonly defaultTimeoutMs?: number;
  readonly onClosed?: (reason: string) => void;
  readonly onNotify?: (event: string, payload: unknown) => void;
}

export class DesktopHostRpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: unknown,
  ) {
    super(message);
    this.name = 'DesktopHostRpcError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toDesktopError(): DesktopError {
    const error: DesktopError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    return this.details === undefined ? error : { ...error, details: this.details };
  }
}

/** Encode one protocol message and reject frames beyond the hard limit. */
export function encodeDesktopHostFrame(message: DesktopHostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > DESKTOP_HOST_MAX_FRAME_BYTES) {
    throw new DesktopHostRpcError(
      'frame-too-large',
      `RPC frame exceeds ${DESKTOP_HOST_MAX_FRAME_BYTES} bytes`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function parseMessage(body: string): DesktopHostMessage {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new DesktopHostRpcError(
      'protocol-error',
      `Invalid JSON frame: ${String((error as Error).message)}`,
    );
  }
  if (!isRecord(value) || value.version !== DESKTOP_HOST_PROTOCOL_VERSION) {
    throw new DesktopHostRpcError(
      'protocol-error',
      'Unsupported or missing desktop-host protocol version',
    );
  }
  if (value.kind === 'req') {
    if (
      typeof value.id !== 'string' ||
      typeof value.method !== 'string' ||
      !('params' in value)
    ) {
      throw new DesktopHostRpcError('protocol-error', 'Malformed request');
    }
    return value as unknown as DesktopHostRequest;
  }
  if (value.kind === 'res') {
    if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') {
      throw new DesktopHostRpcError('protocol-error', 'Malformed response');
    }
    if (
      !value.ok &&
      (!isRecord(value.error) ||
        typeof value.error.code !== 'string' ||
        typeof value.error.message !== 'string' ||
        typeof value.error.retryable !== 'boolean')
    ) {
      throw new DesktopHostRpcError(
        'protocol-error',
        'Error response lacks a valid error object',
      );
    }
    return value as unknown as DesktopHostResponse;
  }
  if (
    value.kind === 'notify' &&
    typeof value.event === 'string' &&
    'payload' in value
  ) {
    return value as unknown as DesktopHostEvent;
  }
  if (value.kind === 'cancel' && typeof value.id === 'string') {
    return value as unknown as DesktopHostCancel;
  }
  throw new DesktopHostRpcError('protocol-error', 'Unknown desktop-host message kind');
}

/** Reassembles complete messages from arbitrary stdio chunks. */
export class DesktopHostFrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): DesktopHostMessage[] {
    if (chunk.length > 0) {
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, chunk])
        : chunk;
    }
    const messages: DesktopHostMessage[] = [];
    for (;;) {
      if (this.buffer.length < 4) return messages;
      const length = this.buffer.readUInt32LE(0);
      if (length > DESKTOP_HOST_MAX_FRAME_BYTES) {
        throw new DesktopHostRpcError(
          'frame-too-large',
          `RPC frame exceeds ${DESKTOP_HOST_MAX_FRAME_BYTES} bytes`,
        );
      }
      if (this.buffer.length < 4 + length) return messages;
      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(parseMessage(body));
    }
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup?: () => void;
}

function asDesktopError(error: unknown): DesktopError {
  if (error instanceof DesktopHostRpcError) return error.toDesktopError();
  if (isRecord(error) && typeof error.message === 'string') {
    const result: DesktopError = {
      code: typeof error.code === 'string' ? error.code : 'handler-error',
      message: error.message,
      retryable: error.retryable === true,
    };
    return 'details' in error
      ? { ...result, details: error.details }
      : result;
  }
  return {
    code: 'handler-error',
    message: String(error),
    retryable: false,
  };
}

/** Bidirectional desktop-host endpoint over a parent/child stdio stream. */
export class DesktopHostRpc {
  private readonly write: Writable;
  private readonly decoder = new DesktopHostFrameDecoder();
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Map<string, DesktopHostHandler>();
  private readonly seenRequestIds = new Set<string>();
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly onClosed: ((reason: string) => void) | undefined;
  private readonly onNotify: ((event: string, payload: unknown) => void) | undefined;
  private closed = false;

  constructor(options: DesktopHostRpcOptions) {
    this.write = options.write;
    this.timeoutMs = options.defaultTimeoutMs ?? DESKTOP_HOST_DEFAULT_TIMEOUT_MS;
    this.onClosed = options.onClosed;
    this.onNotify = options.onNotify;
    this.write.on('error', (error) => {
      this.close(`write-failed: ${String((error as Error).message || error)}`);
    });
  }

  handle(method: string, handler: DesktopHostHandler): void {
    this.handlers.set(method, handler);
  }

  notify(event: string, payload: unknown = null): void {
    this.send({
      kind: 'notify',
      version: DESKTOP_HOST_PROTOCOL_VERSION,
      event,
      payload,
    });
  }

  request<T = unknown>(
    method: string,
    params: unknown = null,
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new DesktopHostRpcError('host-exited', 'desktop-host RPC is closed'));
        return;
      }
      if (signal?.aborted) {
        reject(
          new DesktopHostRpcError(
            'cancelled',
            `desktop-host request cancelled: ${method}`,
            true,
          ),
        );
        return;
      }
      const id = randomUUID();
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.send({
          kind: 'cancel',
          version: DESKTOP_HOST_PROTOCOL_VERSION,
          id,
        });
        reject(
          new DesktopHostRpcError(
            'cancelled',
            `desktop-host request cancelled: ${method}`,
            true,
            { method },
          ),
        );
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(
          new DesktopHostRpcError(
            'timeout',
            `desktop-host request timed out: ${method}`,
            true,
            { method, timeoutMs },
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cleanup,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send({
        kind: 'req',
        version: DESKTOP_HOST_PROTOCOL_VERSION,
        id,
        method,
        params,
      });
    });
  }

  feed(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        void this.dispatch(message);
      }
    } catch (error) {
      const protocol = asDesktopError(error);
      this.close(`${protocol.code}: ${protocol.message}`);
    }
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new DesktopHostRpcError('host-exited', reason, true));
    }
    this.pending.clear();
    this.onClosed?.(reason);
  }

  isClosed(): boolean {
    return this.closed;
  }

  private send(message: DesktopHostMessage): void {
    if (this.closed) return;
    const stream = this.write as Writable & {
      readonly closed?: boolean;
      readonly destroyed?: boolean;
      readonly writableEnded?: boolean;
      readonly writableFinished?: boolean;
    };
    if (
      stream.closed ||
      stream.destroyed ||
      stream.writableEnded ||
      stream.writableFinished
    ) {
      this.close('write-closed');
      return;
    }
    try {
      this.write.write(encodeDesktopHostFrame(message));
    } catch (error) {
      this.close(`write-failed: ${String((error as Error).message)}`);
    }
  }

  private async dispatch(message: DesktopHostMessage): Promise<void> {
    if (message.kind === 'notify') {
      this.onNotify?.(message.event, message.payload);
      return;
    }
    if (message.kind === 'res') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        const error = message.error as DesktopError;
        const rpcError = new DesktopHostRpcError(
          error.code,
          error.message,
          error.retryable,
          error.details,
        );
        pending.reject(rpcError);
      }
      return;
    }
    if (message.kind === 'cancel') {
      this.activeRequests.get(message.id)?.abort();
      return;
    }
    if (this.seenRequestIds.has(message.id)) {
      this.close(`duplicate-request: ${message.id}`);
      return;
    }
    this.seenRequestIds.add(message.id);
    const handler = this.handlers.get(message.method);
    if (!handler) {
      this.send({
        kind: 'res',
        version: DESKTOP_HOST_PROTOCOL_VERSION,
        id: message.id,
        ok: false,
        error: {
          code: 'not-found',
          message: `Unknown desktop-host method: ${message.method}`,
          retryable: false,
        },
      });
      return;
    }
    const controller = new AbortController();
    this.activeRequests.set(message.id, controller);
    try {
      const result = await handler(message.params, {
        id: message.id,
        signal: controller.signal,
      });
      const response: DesktopHostResponse =
        result === undefined
          ? {
              kind: 'res',
              version: DESKTOP_HOST_PROTOCOL_VERSION,
              id: message.id,
              ok: true,
            }
          : {
              kind: 'res',
              version: DESKTOP_HOST_PROTOCOL_VERSION,
              id: message.id,
              ok: true,
              result,
            };
      this.send(response);
    } catch (error) {
      this.send({
        kind: 'res',
        version: DESKTOP_HOST_PROTOCOL_VERSION,
        id: message.id,
        ok: false,
        error: asDesktopError(error),
      });
    } finally {
      this.activeRequests.delete(message.id);
    }
  }
}
