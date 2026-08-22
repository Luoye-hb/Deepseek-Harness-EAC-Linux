import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  DesktopHostFrameDecoder,
  DesktopHostRpc,
  DesktopHostRpcError,
  encodeDesktopHostFrame,
} from '../desktop-host/rpc.ts';

function pair(options: { onClosed?: (reason: string) => void } = {}) {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const a = new DesktopHostRpc({ write: a2b, onClosed: options.onClosed });
  const b = new DesktopHostRpc({ write: b2a });
  a2b.on('data', (chunk) => b.feed(chunk));
  b2a.on('data', (chunk) => a.feed(chunk));
  return { a, b };
}

test('desktop-host frames reassemble across chunks and preserve notifications', () => {
  const message = {
    kind: 'notify' as const,
    version: 1,
    event: 'service.state',
    payload: { state: 'running' },
  };
  const decoder = new DesktopHostFrameDecoder();
  const frame = encodeDesktopHostFrame(message);
  const messages = [];
  for (const byte of frame) messages.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(messages, [message]);
});

test('desktop-host RPC supports request/response and typed errors', async () => {
  const { a, b } = pair();
  b.handle('add', (params) => {
    const p = params as { x: number; y: number };
    return p.x + p.y;
  });
  assert.equal(await a.request<number>('add', { x: 2, y: 3 }), 5);
  await assert.rejects(
    a.request('missing'),
    (error: unknown) =>
      error instanceof DesktopHostRpcError &&
      error.code === 'not-found' &&
      error.retryable === false,
  );
  a.close('done');
  b.close('done');
});

test('desktop-host RPC enforces timeout and rejects pending requests on close', async () => {
  const { a, b } = pair();
  b.handle('hang', () => new Promise(() => {}));
  await assert.rejects(
    a.request('hang', null, 30),
    (error: unknown) =>
      error instanceof DesktopHostRpcError &&
      error.code === 'timeout' &&
      error.retryable === true,
  );
  const pending = a.request('hang', null, 5_000);
  a.close('host exited');
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DesktopHostRpcError && error.code === 'host-exited',
  );
  b.close('done');
});

test('desktop-host RPC sends cancellation and aborts the active handler', async () => {
  const { a, b } = pair();
  let aborted = false;
  b.handle('wait', async (_params, context) => {
    assert.ok(context);
    await new Promise<void>((resolve) => {
      context?.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      );
    });
    return 'late';
  });
  const controller = new AbortController();
  const pending = a.request('wait', null, 5_000, controller.signal);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DesktopHostRpcError &&
      error.code === 'cancelled' &&
      error.retryable === true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  a.close('done');
  b.close('done');
});

test('desktop-host RPC closes on malformed, oversized, and duplicate request frames', async () => {
  const closed: string[] = [];
  const { a, b } = pair({ onClosed: (reason) => closed.push(reason) });
  const malformed = Buffer.alloc(4);
  malformed.writeUInt32LE(2, 0);
  b.feed(Buffer.concat([malformed, Buffer.from('{}')]));
  assert.equal(b.isClosed(), true);

  const duplicate = {
    kind: 'req' as const,
    version: 1,
    id: 'same-id',
    method: 'noop',
    params: null,
  };
  const first = encodeDesktopHostFrame(duplicate);
  a.feed(first);
  a.feed(first);
  assert.equal(a.isClosed(), true);
  assert.match(closed.join('\n'), /duplicate-request/);

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(4 * 1024 * 1024 + 1, 0);
  assert.throws(() => new DesktopHostFrameDecoder().push(oversized), /exceeds/);
  b.close('done');
});

test('desktop-host RPC closes on an invalid structured error response', () => {
  const { a, b } = pair();
  const frame = encodeDesktopHostFrame({
    kind: 'res',
    version: 1,
    id: 'missing-error',
    ok: false,
    error: {} as never,
  });
  a.feed(frame);
  assert.equal(a.isClosed(), true);
  b.close('done');
});

test('desktop-host RPC handles asynchronous writer EPIPE without an uncaught error', async () => {
  const writer = new PassThrough();
  const reasons: string[] = [];
  const rpc = new DesktopHostRpc({
    write: writer,
    onClosed: (reason) => reasons.push(reason),
  });

  rpc.notify('service.state', { state: 'stopping' });
  writer.destroy(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpc.isClosed(), true);
  assert.match(reasons.join('\n'), /write-failed: broken pipe/);
});
