import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  DESKTOP_HOST_DEFAULT_TIMEOUT_MS,
  DESKTOP_HOST_MAX_FRAME_BYTES,
  DESKTOP_HOST_PROTOCOL_VERSION,
} from '../shared/contract/desktop-host.ts';

const root = join(import.meta.dirname, '..');

test('desktop-host contract keeps the planned protocol limits', () => {
  assert.equal(DESKTOP_HOST_PROTOCOL_VERSION, 1);
  assert.equal(DESKTOP_HOST_MAX_FRAME_BYTES, 4 * 1024 * 1024);
  assert.equal(DESKTOP_HOST_DEFAULT_TIMEOUT_MS, 15_000);
});

test('Electron preload consumes the shell-neutral desktop API contract', () => {
  const source = readFileSync(join(root, 'preload', 'api.ts'), 'utf8');
  assert.match(source, /shared\/contract\/desktop-api\.js/);
  assert.match(source, /files:\s*\{/);
  assert.match(source, /onDrop:/);
  assert.match(source, /getPathForFile/);
});

test('desktop bridge matrix inventories all 34 legacy IPC capabilities', () => {
  const source = readFileSync(
    join(root, 'docs', 'tauri-migration', 'desktop-bridge-matrix.md'),
    'utf8',
  );
  const rows = source.match(/^\|\s*\d+\s*\|/gm) ?? [];
  assert.equal(rows.length, 34);
});

test('desktop-host runtime files are included in the current package files list', () => {
  const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const lines = builder.split(/\r?\n/).map((line) => line.trim());
  for (const file of [
    'desktop-host/main.js',
    'desktop-host/rpc.js',
    'shared/contract/desktop-host.js',
    'shared/desktop-core/dsh-web.js',
  ]) {
    assert.equal(lines.includes(`- ${file}`), true, `${file} missing from files list`);
  }
});

test('DesktopPlatform stays shell-neutral', () => {
  const source = readFileSync(join(root, 'shared', 'contract', 'desktop-platform.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:electron|@tauri-apps\/api)/);
  assert.match(source, /export interface DesktopPlatform/);
  assert.match(source, /createWindow/);
  assert.match(source, /registerShortcut/);
});
