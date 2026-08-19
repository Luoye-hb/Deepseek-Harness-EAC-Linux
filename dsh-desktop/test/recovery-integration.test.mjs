// TDD wiring tests: the recovery/watchdog modules must actually be wired
// into the desktop shell. main.js is an Electron entry (untestable under
// node:test directly), so we pin the wiring points at the source level —
// each assertion corresponds to a required integration point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8');
const preloadSrc = readFileSync(join(ROOT, 'preload.js'), 'utf8');
// Task 3：渲染自恢复装配（initRendererRecovery/wireWindowRecovery/心跳轮询）
// 迁 lib/window.ts。
const windowSrc = readFileSync(join(ROOT, 'lib', 'window.ts'), 'utf8');

test('main.js requires the renderer-recovery module', () => {
  // Task 3：lib/window.ts 以 ESM import 引 renderer-recovery.js（编译为 require）。
  assert.ok(/from '\.\.\/renderer-recovery\.js'/.test(windowSrc), "lib/window.ts must import '../renderer-recovery.js'");
});

test('main.js builds the recovery state machine and attaches the main window', () => {
  assert.ok(/export function initRendererRecovery\(\)/.test(windowSrc), 'initRendererRecovery() missing');
  // Task 1.1：顶层状态迁 lib/state.ts 单例后，引用统一为 state.recovery / state.mainWindow。
  assert.ok(/state\.recovery\.attach\(state\.mainWindow,\s*'main'\)/.test(windowSrc), 'main window attach missing');
});

test('main.js runs the watchdog lifecycle: run-state write, spawn, clean-exit mark', () => {
  // Task 2：run-state/writeRunState/markCleanExit 迁 lib/run-state.ts，
  // startWatchdog 迁 lib/watchdog-boot.ts；main.js 经 require 接线并在 boot 链调用。
  const runStateSrc = readFileSync(join(ROOT, 'lib', 'run-state.ts'), 'utf8');
  const watchdogSrc = readFileSync(join(ROOT, 'lib', 'watchdog-boot.ts'), 'utf8');
  assert.ok(/export function writeRunState\(/.test(runStateSrc), 'writeRunState() missing');
  assert.ok(/export function markCleanExit\(/.test(runStateSrc), 'markCleanExit() missing');
  assert.ok(/export function startWatchdog\(\)/.test(watchdogSrc), 'startWatchdog() missing');
  assert.ok(/require\('\.\/lib\/watchdog-boot\.js'\)/.test(mainSrc), 'watchdog-boot wiring missing');
  assert.ok(/startWatchdog\(\);/.test(mainSrc), 'startWatchdog() is never called');
});

test('main.js registers the heartbeat IPC and polls heartbeats', () => {
  assert.ok(mainSrc.includes("'dsh:renderer-heartbeat'"), 'heartbeat IPC channel missing');
  // Task 3：心跳轮询迁 lib/window.ts 的 startHeartbeatLoop。
  assert.ok(/checkHeartbeats\(\)/.test(windowSrc), 'checkHeartbeats() loop missing');
});

test('main.js serves the local recovery page IPC endpoints', () => {
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:export-logs']) {
    assert.ok(mainSrc.includes(`'${ch}'`), `IPC handler ${ch} missing`);
  }
  assert.ok(existsSync(join(ROOT, 'assets', 'recovery.html')), 'assets/recovery.html missing');
});

test('every quit path marks a clean exit for the watchdog', () => {
  const marks = mainSrc.match(/markCleanExit\(\)/g) || [];
  assert.ok(marks.length >= 3, `expected markCleanExit() on before-quit + restart + app.exit paths, found ${marks.length}`);
});

test('preload sends renderer heartbeats and exposes the recovery bridge', () => {
  assert.ok(preloadSrc.includes("'dsh:renderer-heartbeat'"), 'preload heartbeat sender missing');
  for (const ch of ['chrome:recovery-state', 'chrome:recovery-reload', 'chrome:recovery-restart', 'chrome:export-logs']) {
    assert.ok(preloadSrc.includes(`'${ch}'`), `preload bridge for ${ch} missing`);
  }
});
