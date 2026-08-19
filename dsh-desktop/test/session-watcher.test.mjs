// Session-watcher 通知契约测试（移植自 scripts/test-watcher.js 手工探针，
// 使其纳入 npm test 自动运行）。
//
// 会话日志为「拼接 zstd 帧」格式：首帧第一行是 session header。扫描器
// 首次看到的帧算 baseline（历史事件不通知），之后新出现的完成事件才触发
// onTurnEnd：
//   - 现行格式（有 turn/start|turn/end）：turn/end 即任务完成，通知；
//   - 旧格式（无 turn 事件）：退化为 assistant/message 通知；
//   - delegationDepth > 0 的子代理日志不通知（对 toast 是噪音）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { SessionWatcher, scanZstdFrames } from '../session-watcher.js';

function makeScenario(name) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-watch-'));
  const sessionDir = join(root, '--proj--', 'session-' + name);
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, 'session.jsonl.zstd');
  const frame = (records) => zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  const header = { type: 'session', version: 0, id: 'session-' + name, createdAt: 1, cwd: 'C:\\proj', delegationDepth: 0 };
  writeFileSync(file, frame([header]));
  return { root, file, frame };
}

test('current-format session: historical turn/end never notifies, live turn/end does', () => {
  const { root, file, frame } = makeScenario('turnmode');
  try {
    const seen = [];
    const w = new SessionWatcher({ sessionsDir: root, onTurnEnd: (i) => seen.push(i), log: () => {} });
    appendFileSync(file, frame([
      { type: 'turn/start', seq: 0 },
      { type: 'assistant/message', seq: 1 },
      { type: 'turn/end', seq: 2 },
      { type: 'session/title', seq: 3, data: { title: '标题A' } },
    ]));
    w.scan(); // baseline：历史事件不通知
    assert.equal(seen.length, 0);

    appendFileSync(file, frame([
      { type: 'turn/start', seq: 4 },
      { type: 'assistant/message', seq: 5 },
      { type: 'assistant/message', seq: 6 },
      { type: 'turn/end', seq: 7 },
    ]));
    w.scan();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title, '标题A'); // title 来自 session/title 事件
    assert.equal(seen[0].sessionId, 'session-turnmode');
    assert.equal(seen[0].cwd, 'C:\\proj');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy session without turn events falls back to assistant/message', () => {
  const { root, file, frame } = makeScenario('legacymode');
  try {
    const seen = [];
    const w = new SessionWatcher({ sessionsDir: root, onTurnEnd: (i) => seen.push(i), log: () => {} });
    appendFileSync(file, frame([{ type: 'assistant/message', seq: 0 }]));
    w.scan(); // baseline
    assert.equal(seen.length, 0);

    appendFileSync(file, frame([{ type: 'assistant/message', seq: 1 }]));
    w.scan();
    assert.equal(seen.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subagent sessions (delegationDepth > 0) never notify', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-watch-'));
  try {
    const sessionDir = join(root, '--proj--', 'session-sub');
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'session.jsonl.zstd');
    const frame = (records) => zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
    const seen = [];
    const w = new SessionWatcher({ sessionsDir: root, onTurnEnd: (i) => seen.push(i), log: () => {} });
    writeFileSync(file, frame([{ type: 'session', version: 0, id: 'session-sub', createdAt: 1, cwd: 'C:\\proj', delegationDepth: 1 }]));
    w.scan(); // baseline
    appendFileSync(file, frame([{ type: 'turn/end', seq: 1 }]));
    w.scan();
    assert.equal(seen.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanZstdFrames reports torn tail for a truncated frame', () => {
  const compressed = zlib.zstdCompressSync(Buffer.from('{"type":"turn/end"}\n'));
  const { frames, tornStart } = scanZstdFrames(Buffer.concat([compressed, compressed.subarray(0, 3)]));
  assert.equal(frames.length, 1);
  assert.equal(typeof tornStart, 'number');
});
