import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = require(join(root, 'assets', 'plugins', 'dsh-tool-vision', 'index.js'));

// 回归：v4.0.1 及上游 v4.0.0 的 attachRequestGuard 把 llm/stream 监听器写成
// async 函数 —— 返回 Promise 而非 async iterable，cordis 瀑布流的
// yield* next() 抛 "yield* (intermediate value) is not async iterable"，
// 每轮模型请求必失败。监听器必须同步返回 async generator。
// 用一个最小 ctx.on 捕获注册的监听器，直接驱动它验证契约。

function makeCtx() {
  const listeners = {};
  return {
    listeners,
    on: (event, fn) => { (listeners[event] ||= []).push(fn); },
    logger: { info() {}, warn() {} },
    attachments: { readImage: async () => ({ data: Buffer.from('x') }) },
  };
}

function isAsyncIterable(value) {
  return value != null && typeof value[Symbol.asyncIterator] === 'function';
}

// next() 返回一个单块 async generator（瀑布流下游的最小形态）。
function downstreamGen(tag) {
  return async function* () {
    yield tag;
  };
}

test('llm/stream 监听器同步返回 async iterable（非 Promise）', async () => {
  const ctx = makeCtx();
  const getConfig = () => ({ requestGuard: true, multimodalModels: [] });
  plugin.attachRequestGuard(ctx, getConfig, '/tmp');
  assert.ok(ctx.listeners['llm/stream']?.length === 1, '应注册一个 llm/stream 监听器');
  const listener = ctx.listeners['llm/stream'][0];
  const ret = listener({ model: 'text-model', messages: [] }, downstreamGen('down'));
  assert.ok(!(ret instanceof Promise), '监听器返回值不能是 Promise（v4.0.1 回归 bug）');
  assert.ok(isAsyncIterable(ret), '监听器必须返回 async iterable');
  const chunks = [];
  for await (const chunk of ret) chunks.push(chunk);
  assert.deepEqual(chunks, ['down']);
});

test('守卫命中时把改写后的 options 传给下游（yield* next(...) 语义）', async () => {
  const ctx = makeCtx();
  const getConfig = () => ({ requestGuard: true, multimodalModels: [] });
  plugin.attachRequestGuard(ctx, getConfig, '/tmp');
  const listener = ctx.listeners['llm/stream'][0];
  // 带 image block 的请求触发 bridgeMessages 路径（ctx.attachments 打桩）。
  const options = { model: 'text-model', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }] }] };
  const ret = listener(options, async function* (opts) {
    yield opts === options ? 'same-ref' : 'rewritten';
  });
  const chunks = [];
  for await (const chunk of ret) chunks.push(chunk);
  assert.deepEqual(chunks, ['rewritten']);
});

test('守卫不适用时透传（无参 next()，瀑布流保持原 options）', async () => {
  const ctx = makeCtx();
  const getConfig = () => ({ requestGuard: true, multimodalModels: ['m1'] });
  plugin.attachRequestGuard(ctx, getConfig, '/tmp');
  const listener = ctx.listeners['llm/stream'][0];
  // m1 在白名单里 → 守卫不触发 → yield* next() 无参调用
  //（瀑布流语义：下游沿用当前 options，不传改写副本）。
  const options = { model: 'm1', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png' } }] }] };
  let sawArgs = 'none';
  const ret = listener(options, async function* (o) {
    sawArgs = o === undefined ? 'no-arg' : (o === options ? 'same-ref' : 'rewritten');
    yield sawArgs;
  });
  const chunks = [];
  for await (const chunk of ret) chunks.push(chunk);
  assert.deepEqual(chunks, ['no-arg']);
});

test('getConfig 抛错不拖垮瀑布流（守卫永不破坏调用）', async () => {
  const ctx = makeCtx();
  const getConfig = () => { throw new Error('boom'); };
  plugin.attachRequestGuard(ctx, getConfig, '/tmp');
  const listener = ctx.listeners['llm/stream'][0];
  const options = { model: 'm', messages: [] };
  const ret = listener(options, downstreamGen('fallback'));
  const chunks = [];
  for await (const chunk of ret) chunks.push(chunk);
  assert.deepEqual(chunks, ['fallback'], '异常时应走无参 next() 原样放行');
});
