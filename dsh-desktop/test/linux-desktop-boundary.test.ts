import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const linuxUpdate = require(path.join(root, 'lib', 'linux-update.js'));
const terminal = require(path.join(root, 'lib', 'terminal-platform.js'));
const clientUpdater = require(path.join(root, 'client-updater.js'));
const pluginRegistry = require(path.join(root, 'lib', 'plugin-registry-data.js'));

function source(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function guidanceFor(osRelease: string, appImagePath = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-update-'));
  const file = path.join(dir, 'os-release');
  fs.writeFileSync(file, osRelease);
  try {
    return linuxUpdate.linuxUpdateGuidance({ osReleasePath: file, appImagePath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Linux update guidance is typed and covers AppImage plus four package managers', () => {
  const cases = [
    ["ID=arch\n", /pacman -Syu/],
    ["ID=ubuntu\nID_LIKE=debian\n", /apt update/],
    ["ID=fedora\n", /dnf upgrade/],
    ["ID=opensuse-tumbleweed\nID_LIKE='suse opensuse'\n", /zypper update/],
  ] as const;
  for (const [release, command] of cases) {
    const result = guidanceFor(release);
    assert.equal(typeof result.message, 'string');
    assert.equal(typeof result.detail, 'string');
    assert.match(result.detail, command);
  }
  const image = guidanceFor('ID=arch\n', '/opt/Deepseek Harness EAC.AppImage');
  assert.match(image.message, /AppImage/);
  assert.match(image.detail, /Deepseek Harness EAC\.AppImage/);
});

test('Linux terminal shims are user-data-local, executable, and target bundled Node/npm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-shims-'));
  const nodePath = '/opt/deepseek harness/resources/node/node';
  const npmCli = '/opt/deepseek harness/resources/npm/bin/npm-cli.js';
  try {
    const shims = terminal.createTerminalShims(dir, nodePath, npmCli, 'linux');
    assert.equal(shims.binDir, path.join(dir, 'terminal-bin'));
    for (const name of ['node', 'npm', 'npx']) {
      const file = shims[name];
      assert.equal(fs.statSync(file).mode & 0o777, 0o755);
      assert.match(fs.readFileSync(file, 'utf8'), /^#!\/bin\/sh\nexec /);
    }
    assert.match(fs.readFileSync(shims.node, 'utf8'), /resources\/node\/node/);
    assert.match(fs.readFileSync(shims.npm, 'utf8'), /npm-cli\.js/);
    assert.match(fs.readFileSync(shims.npx, 'utf8'), /npx-cli\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux terminal adapter selection follows the required desktop order', () => {
  assert.deepEqual(terminal.linuxTerminalAdapters().map((v: { command: string }) => v.command), [
    'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal',
  ]);
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-path-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-path-b-'));
  try {
    for (const [dir, name] of [[first, 'konsole'], [second, 'gnome-terminal']] as const) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
    const selected = terminal.selectLinuxTerminal([first, second].join(path.delimiter));
    assert.equal(selected.adapter.command, 'gnome-terminal');
    assert.equal(selected.executable, path.join(second, 'gnome-terminal'));
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('desktop source keeps Linux frameless, close-to-exit, and tray-free', () => {
  const windowSource = source('lib/window.ts');
  const traySource = source('lib/tray.ts');
  const mainSource = source('main.ts');
  assert.equal((windowSource.match(/frame:\s*false/g) ?? []).length >= 2, true);
  assert.equal((windowSource.match(/IS_WIN \? \{ roundedCorners: true \}/g) ?? []).length, 2);
  assert.match(windowSource, /state\.forceQuit \|\| !IS_WIN \|\| !state\.tray/);
  assert.match(traySource, /createTray\(\): void \{\s*if \(!IS_WIN\) return/);
  assert.match(traySource, /trayHintOnce\(\): void \{\s*if \(!IS_WIN/);
  assert.match(mainSource, /window-all-closed[\s\S]*if \(!bootWindowReady\) return/);
  assert.match(mainSource, /await boot\(\);\s*bootWindowReady = true/);
  assert.match(mainSource, /if \(!IS_WIN \|\| !state\.tray\) app\.quit\(\)/);
});

test('Linux startup initializes and syncs the desktop profile before launching dsh web', () => {
  const pluginsSource = source('lib/plugins.ts');
  const bootSource = source('lib/boot.ts');
  assert.doesNotMatch(pluginsSource, /syncCompanionPlugins\(\): void \{\s*if \(!IS_WIN\) return/);
  assert.match(pluginsSource, /syncCompanionPlugins\(\): void \{[\s\S]*ensureDesktopProfileInit\(\)/);
  assert.match(
    bootSource,
    /await runPluginOnboardingIfNeeded\(onboardingNeeded\);[\s\S]*syncCompanionPlugins\(\);[\s\S]*startAndShowGuarded\(\)/,
  );
});

test('Linux companion sync mounts picturereader and disables overlapping image injectors by default', () => {
  const plugins = pluginRegistry.COMPANION_PLUGINS as Array<{
    id: string;
    name: string;
    dir?: string;
    disabled?: boolean;
  }>;
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  assert.deepEqual(byId.get('picturereader'), {
    id: 'picturereader',
    name: 'picturereader',
    dir: 'picturereader',
  });
  assert.equal(byId.has('tool-vision'), false);
  assert.equal(pluginRegistry.PLUGIN_UPDATE_SOURCES.picturereader.npm, 'picturereader');
  assert.equal(pluginRegistry.PLUGIN_UPDATE_SOURCES['tool-vision'], undefined);
  assert.notEqual(byId.get('file-drop-eac')?.disabled, true);
  assert.equal(byId.get('image-paste')?.disabled, true);

  const pluginDir = path.join(root, 'assets', 'plugins', byId.get('picturereader')?.dir ?? '');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')) as { name?: string };
  assert.equal(manifest.name, 'picturereader');
  assert.match(fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8'), /id:\s*picturereader/);
});

test('Linux client update boundary is guidance-only and disables background/apply/rollback paths', () => {
  const flow = source('lib/update-flow.ts');
  const boot = source('lib/boot.ts');
  const apply = source('lib/client-update/apply.ts');
  const runState = source('lib/run-state.ts');
  const shortcuts = source('lib/shortcuts.ts');
  assert.match(flow, /runClientUpdateFlow[\s\S]*process\.platform !== 'win32'[\s\S]*linuxUpdateGuidance/);
  assert.match(flow, /offerPendingClientUpdate\(\): void \{\s*if \(process\.platform !== 'win32'\) return/);
  assert.match(flow, /scheduleClientUpdateRescue\(\): void \{\s*if \(process\.platform !== 'win32'\) return/);
  assert.match(boot, /IS_WIN && !process\.env\.DSH_DESKTOP_SKIP_CLIENT_UPDATE/);
  assert.match(apply, /applyUpdate[\s\S]*process\.platform !== 'win32'[\s\S]*系统包管理器/);
  assert.equal((runState.match(/if \(!IS_WIN\) return/g) ?? []).length >= 3, true);
  assert.match(shortcuts, /if \(!app\.isPackaged \|\| !IS_WIN\) return/);
  if (process.platform !== 'win32') {
    assert.throws(
      () => clientUpdater.applyUpdate({ userDataDir: '/tmp/unused', log() {} }, { path: '/tmp/update.exe' }),
      /系统包管理器/,
    );
  }
});
