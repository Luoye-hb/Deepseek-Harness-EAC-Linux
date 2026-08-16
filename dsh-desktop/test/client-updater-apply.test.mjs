// TDD regression tests for the apply-update.cmd script generation (issue #8).
//
// Bug: the installer-branch script waited for the app process to exit with NO
// timeout and NO force-kill. Tray apps keep the process alive after the window
// closes, so :wait never ended, the new Setup never ran, and the 174 MB
// installer plus script leaked forever in updates\. Users saw "重启以应用"
// do nothing in a loop.
//
// The fix, tested here:
//   1. bounded wait (~30s) then force-kill via taskkill /F /T
//   2. every phase appends to a log file next to the script
//   3. the Setup exit code is checked; on failure the old app is relaunched
//      and the installer + log are KEPT for diagnosis (no silent residue loop)
//   4. cleanup only happens on success
//   5. script lines are CRLF-joined pure ASCII

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplyScript, buildSpawnCommandLine } from '../client-updater.js';

const CTX = { userDataDir: 'C:\\userData' };

test('installer branch waits with a bounded loop and force-kills after the limit', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const joined = lines.join('\n');

  // bounded counter
  assert.match(joined, /set\s+\/a\s+tries/g, 'must count wait iterations');
  assert.match(joined, /gtr\s+\d+/, 'wait loop must have an iteration limit');
  const waitIdx = lines.findIndex((l) => l.trim() === ':wait');
  const killIdx = lines.findIndex((l) => /taskkill\s+\/F\s+\/T\s+\/IM/.test(l));
  assert.ok(waitIdx >= 0, 'must have a :wait label');
  assert.ok(killIdx > waitIdx, 'force-kill must come after the wait label');
  // the loop exits into the kill path, not into running the setup directly
  const limitLine = lines.find((l) => /gtr\s+\d+/.test(l));
  assert.match(limitLine, /goto\s+:?kill/i, 'hitting the limit must jump to :kill');
});

test('script writes a log file and records the setup exit code', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const joined = lines.join('\n');
  assert.match(joined, /apply-update\.log/, 'must reference a log file');
  // log lines are appended with >>
  const logLines = lines.filter((l) => l.includes('>>'));
  assert.ok(logLines.length >= 3, 'must log wait/kill/run phases, got ' + logLines.length);
  // setup exit code recorded into the log
  assert.match(joined, /errorlevel/i);
  const exitLogLine = lines.find((l) => /exit code/.test(l));
  assert.ok(exitLogLine, 'must have an exit-code log line');
  assert.match(exitLogLine, />>\s*"%LOG%"/, 'exit code must be appended to the log');
});

test('on setup failure the old app is relaunched and artifacts are kept', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const joined = lines.join('\n');
  const failIdx = lines.findIndex((l) => /^:failed$/i.test(l.trim()));
  assert.ok(failIdx >= 0, 'must have a :failed label');
  const afterFail = lines.slice(failIdx).join('\n');
  assert.match(afterFail, /start\s+""\s+"%OLD%"/i, 'failed update must relaunch the old app');
  // and must NOT delete the setup in the failure path
  assert.doesNotMatch(afterFail, /del\s+"%SETUP%"/i, 'failure path must keep the installer for diagnosis');
});

test('cleanup of setup+script only happens on the success path', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: false });
  const successIdx = lines.findIndex((l) => /^:success$/i.test(l.trim()));
  assert.ok(successIdx >= 0, 'must have a :success label');
  const afterSuccess = lines.slice(successIdx).join('\n');
  assert.match(afterSuccess, /del\s+"%SETUP%"/i, 'success path must delete the installer');
  assert.match(afterSuccess, /del\s+"%~f0"/i, 'success path must delete the script itself');
});

test('portable branch keeps backup/replace/restore semantics and gains the same bounded wait', () => {
  const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\new.exe', oldExe: 'D:\\portable\\app.exe', portable: true });
  const joined = lines.join('\n');
  assert.match(joined, /OLD%\.bak/, 'portable branch must still back up the old exe');
  assert.match(joined, /copy\s+\/y\s+"%NEW%"\s+"%OLD%"/i, 'portable branch must still replace in place');
  assert.match(joined, /gtr\s+\d+/, 'portable wait must be bounded too');
  assert.match(joined, /apply-update\.log/, 'portable branch must log too');
});

test('all generated lines are ASCII with no bare CRLF inside line content', () => {
  for (const variant of [true, false]) {
    const lines = buildApplyScript({ ctx: CTX, newExe: 'C:\\updates\\setup.exe', oldExe: 'C:\\Programs\\app\\app.exe', portable: variant });
    for (const line of lines) {
      assert.ok(/^[\x20-\x7E]*$/.test(line), 'non-ASCII line in script: ' + JSON.stringify(line));
      assert.doesNotMatch(line, /\r|\n/, 'embedded newline in line: ' + JSON.stringify(line));
    }
  }
});

// v2.0.x 回归（蓝七反馈“点立即重启没反应”）：spawn('cmd.exe', ['/c', script,
// ...args]) 让 Node 给含空格参数加引号，cmd /c 剥掉首尾引号后路径在空格处
// 断开（'C:\...\Deepseek' is not recognized），且 stdio:'ignore' 吞掉报错 →
// apply-update.cmd 静默不执行。修复 = /d /s /c + windowsVerbatimArguments +
// 整行外层再包一对引号（/s 剥外层后还原标准参数行）。
test('spawn command line wraps the whole arg row in an extra outer quote pair', () => {
  const script = 'C:\\Users\\a b\\AppData\\Roaming\\Deepseek Harness EAC\\updates\\apply-update.cmd';
  const args = [
    'C:\\Users\\a b\\AppData\\Roaming\\Deepseek Harness EAC\\updates\\Deepseek-Harness-EAC-Setup-x64.exe',
    'Deepseek Harness EAC.exe',
  ];
  const line = buildSpawnCommandLine(script, args);
  // 期望形式：""script" "arg1" "arg2"" —— /s 剥外层后还原为每参数带引号的标准行
  assert.equal(line, '"' + [script, ...args].map((a) => `"${a}"`).join(' ') + '"');
});
