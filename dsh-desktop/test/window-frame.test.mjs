import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { customFrameOptions } = require('../window-frame.js');

test('Windows and Linux use the custom frameless chrome', () => {
  assert.deepEqual(customFrameOptions('win32'), {
    frame: false,
    roundedCorners: true,
  });
  assert.deepEqual(customFrameOptions('linux'), { frame: false });
});

test('macOS keeps its native frame and application menu', () => {
  assert.deepEqual(customFrameOptions('darwin'), {});
});

test('all custom-chrome BrowserWindows share the platform frame policy', () => {
  const main = readFileSync(join(root, 'main.js'), 'utf8');
  for (const functionName of ['createWindow', 'createFloatWindow', 'openPluginWizard']) {
    const start = main.indexOf(`function ${functionName}`);
    assert.ok(start >= 0, `${functionName} must exist`);
    const windowOptions = main.slice(start, start + 1600);
    assert.match(
      windowOptions,
      /new BrowserWindow\s*\([\s\S]*?\.\.\.customFrameOptions\(\)/,
      `${functionName} must use the shared custom frame policy`,
    );
  }
});

test('the updater modal keeps native window controls', () => {
  const main = readFileSync(join(root, 'main.js'), 'utf8');
  const start = main.indexOf('function showUpdateWindow');
  assert.ok(start >= 0, 'showUpdateWindow must exist');
  const windowOptions = main.slice(start, start + 700);
  assert.doesNotMatch(windowOptions, /customFrameOptions/);
});
