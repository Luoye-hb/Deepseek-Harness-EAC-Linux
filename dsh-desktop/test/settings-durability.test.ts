import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { loadSettings, saveSettings, settingsPath, type SettingsContext } from '../settings.js';
import { dshHomePath } from '../lib/dsh-home.js';

function fixture(): { dir: string; ctx: SettingsContext; logs: string[]; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-'));
  const logs: string[] = [];
  return {
    dir,
    logs,
    ctx: { userDataDir: dir, log: (_tag, message) => logs.push(message) },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('saveSettings validates fields, writes schemaVersion, and enforces 0600', () => {
  const f = fixture();
  try {
    saveSettings(f.ctx, {
      notifyOnTurnEnd: true,
      closeToTray: 'bad',
      webPort: 70000,
      removedPlugins: ['one', 2, 'two'],
      extensionOwned: { kept: true },
    });
    const file = settingsPath(f.ctx);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.notifyOnTurnEnd, true);
    assert.equal('closeToTray' in saved, false);
    assert.equal('webPort' in saved, false);
    assert.deepEqual(saved.removedPlugins, ['one', 'two']);
    assert.deepEqual(saved.extensionOwned, { kept: true });
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('corrupt primary is preserved and a valid replacement backup is restored', () => {
  const f = fixture();
  try {
    const file = settingsPath(f.ctx);
    writeFileSync(file, '{broken', { mode: 0o600 });
    writeFileSync(`${file}.backup`, '{"notifyOnTurnEnd":false}', { mode: 0o600 });
    assert.equal(loadSettings(f.ctx).notifyOnTurnEnd, false);
    assert.ok(readdirSync(f.dir).some((name) => name.startsWith('settings.json.corrupt-')));
    assert.equal(readFileSync(file, 'utf8'), '{"notifyOnTurnEnd":false}');
  } finally { f.cleanup(); }
});

test('interrupted writes recover only valid JSON and retain invalid temp evidence', () => {
  const f = fixture();
  try {
    const file = settingsPath(f.ctx);
    const valid = `${file}.tmp-valid`;
    const invalid = `${file}.tmp-invalid`;
    writeFileSync(valid, '{"shareWebProfile":true}', { mode: 0o600 });
    writeFileSync(invalid, '{nope', { mode: 0o600 });
    const now = new Date();
    utimesSync(valid, new Date(now.getTime() - 1000), new Date(now.getTime() - 1000));
    utimesSync(invalid, now, now);
    assert.equal(loadSettings(f.ctx).shareWebProfile, true);
    assert.ok(readdirSync(f.dir).some((name) => name.startsWith('settings.json.corrupt-temp-')));
  } finally { f.cleanup(); }
});

test('an invalid interrupted temp never replaces an existing valid primary', () => {
  const f = fixture();
  try {
    const file = settingsPath(f.ctx);
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(file, '{"clientAutoUpdate":false}', { mode: 0o644 });
    writeFileSync(`${file}.tmp-crash`, '{bad', { mode: 0o600 });
    assert.equal(loadSettings(f.ctx).clientAutoUpdate, false);
    assert.ok(readdirSync(f.dir).some((name) => name.startsWith('settings.json.corrupt-temp-')));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('a failed write leaves the previous settings file intact', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    const file = settingsPath(f.ctx);
    writeFileSync(file, '{"notifyOnTurnEnd":true}\n', { mode: 0o600 });
    chmodSync(f.dir, 0o500);
    saveSettings(f.ctx, { notifyOnTurnEnd: false });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).notifyOnTurnEnd, true);
    assert.ok(f.logs.some((message) => message.includes('保存 settings 失败')));
  } finally {
    chmodSync(f.dir, 0o700);
    f.cleanup();
  }
});

test('dshHomePath honors and resolves DSH_HOME', () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = './custom-dsh-home';
    assert.equal(dshHomePath(), join(process.cwd(), 'custom-dsh-home'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
