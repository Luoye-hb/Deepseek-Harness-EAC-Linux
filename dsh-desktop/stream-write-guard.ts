/**
 * stream-write-guard.ts — Writable 生命周期保护。
 *
 * ChildProcess 的 exit 早于 stdout/stderr close；日志流必须等 close 后结束，
 * 并拒绝迟到的写入，避免 ERR_STREAM_WRITE_AFTER_END 变成未处理错误。
 */

import type { Writable } from 'node:stream';

export interface StreamWriteGuard {
  write(chunk: string | Uint8Array): boolean;
  end(): boolean;
  readonly closing: boolean;
  readonly ended: boolean;
}

export interface StreamWriteGuardOptions {
  onError?(error: Error): void;
}

export function createStreamWriteGuard(stream: Writable, opts: StreamWriteGuardOptions = {}): StreamWriteGuard {
  const onError = opts.onError ?? (() => {});
  let closing = false;
  let ended = false;
  const report = (error: unknown): void => {
    try {
      onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      /* 日志错误不能再次中断业务路径 */
    }
  };

  stream.on('error', report);
  return {
    write(chunk: string | Uint8Array): boolean {
      if (closing || ended || stream.destroyed || stream.writableEnded || stream.writable === false) return false;
      try {
        return stream.write(chunk);
      } catch (error) {
        report(error);
        return false;
      }
    },
    end(): boolean {
      if (closing || ended) return false;
      closing = true;
      if (stream.destroyed || stream.writableEnded) {
        ended = true;
        return false;
      }
      try {
        stream.end(() => {
          ended = true;
        });
        return true;
      } catch (error) {
        ended = true;
        report(error);
        return false;
      }
    },
    get closing(): boolean {
      return closing;
    },
    get ended(): boolean {
      return ended || stream.writableEnded || stream.destroyed;
    },
  };
}
