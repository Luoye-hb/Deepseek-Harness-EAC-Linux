import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

test('Tauri workspace keeps the planned shell boundary', () => {
  const config = fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8');
  const capabilities = fs.readFileSync(
    path.join(root, 'src-tauri', 'capabilities', 'default.json'),
    'utf8',
  );
  const bridge = fs.readFileSync(
    path.join(root, 'platform', 'tauri', 'dist', 'bridge.js'),
    'utf8',
  );
  assert.match(config, /"frontendDist":\s*"\.\.\/platform\/tauri\/dist"/);
  assert.match(config, /"withGlobalTauri":\s*false/);
  assert.match(config, /"\.\.\/lib"/);
  assert.match(config, /"\.\.\/scripts"/);
  assert.match(config, /"\.\.\/node_modules"/);
  assert.match(config, /createUpdaterArtifacts/);
  assert.match(config, /releases\/latest\/download\/latest\.json/);
  assert.match(capabilities, /"core:default"/);
  assert.match(bridge, /desktop_host_start|desktop_window_control/);
  assert.match(bridge, /desktop_host_call/);
  assert.match(bridge, /balance:prices:get/);
  assert.match(bridge, /file:revert/);
  assert.match(bridge, /desktop_open_path/);
  assert.match(bridge, /image-paste:save/);
  assert.match(bridge, /desktop_menu_action/);
  assert.match(bridge, /desktop_recovery_action/);
  assert.match(bridge, /desktop_recovery_window_close/);
  assert.match(bridge, /desktop_renderer_heartbeat/);
  assert.match(bridge, /desktop_page_error/);
  assert.match(bridge, /onboard:close/);
  assert.match(bridge, /onboard:list/);
  assert.match(bridge, /recovery:action/);
  assert.match(bridge, /update:check/);
  assert.match(bridge, /target\.update/);
  assert.match(bridge, /desktop_about_info/);
  assert.match(bridge, /target\.onboarding/);
  assert.match(bridge, /target\.rc/);
  assert.match(bridge, /DropPathResolver/);
  assert.doesNotMatch(bridge, /getPathForFile:\s*\(\)\s*=>\s*''/);
  assert.doesNotMatch(bridge, /desktop_action/);
  assert.doesNotMatch(bridge, /function unsupported/);
  assert.doesNotMatch(bridge, /from ['"]@tauri-apps\/api/);

  for (const page of [
    'loading.html',
    'onboarding.html',
    'recovery-center.html',
    'update.html',
    'about.html',
  ]) {
    assert.equal(
      fs.existsSync(path.join(root, 'platform', 'tauri', 'dist', page)),
      true,
      `${page} must be copied into the Tauri frontend distribution`,
    );
  }
});

test('Tauri release configuration has explicit updater and staging gates', () => {
  const config = fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8');
  const staging = fs.readFileSync(path.join(root, 'scripts', 'prepare-tauri-staging.mjs'), 'utf8');
  const configScript = fs.readFileSync(path.join(root, 'scripts', 'prepare-tauri-config.mjs'), 'utf8');
  assert.doesNotMatch(config, /"pacman"/);
  assert.match(config, /"createUpdaterArtifacts":\s*true/);
  assert.match(config, /"__TAURI_UPDATER_PUBLIC_KEY_REQUIRED__"/);
  assert.match(staging, /electronOnly/);
  assert.match(staging, /'electron-builder'/);
  assert.match(staging, /'settings\.js'/);
  assert.match(staging, /'client-updater\.js'/);
  assert.match(staging, /staging-manifest\.json/);
  assert.match(configScript, /TAURI_SIGNING_PUBLIC_KEY/);
  assert.match(configScript, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(configScript, /\.tauri-staging/);
  const missingKey = childProcess.spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'prepare-tauri-config.mjs'), '--release'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, TAURI_SIGNING_PUBLIC_KEY: '', TAURI_SIGNING_PRIVATE_KEY: '' } },
  );
  assert.notEqual(missingKey.status, 0, 'release config must reject missing signing keys');
});

test('Tauri dynamic windows have independent local roles and navigation guards', () => {
  const windows = fs.readFileSync(
    path.join(root, 'src-tauri', 'src', 'windows.rs'),
    'utf8',
  );
  const commands = fs.readFileSync(
    path.join(root, 'src-tauri', 'src', 'commands.rs'),
    'utf8',
  );
  const instance = fs.readFileSync(
    path.join(root, 'src-tauri', 'src', 'instance.rs'),
    'utf8',
  );
  assert.match(windows, /on_navigation/);
  assert.match(windows, /on_new_window/);
  assert.match(windows, /data_directory/);
  assert.match(windows, /float_initialization_script/);
  assert.match(windows, /window\.__DSH_FLOAT__/);
  assert.match(windows, /onboarding\.html/);
  assert.match(windows, /recovery-center\.html/);
  assert.match(windows, /update\.html/);
  assert.match(windows, /about\.html/);
  assert.match(commands, /update window cannot call this desktop-host method/);
  assert.doesNotMatch(commands, /window\.alert/);
  assert.match(windows, /is_safe_external/);
  assert.match(commands, /wizard window cannot call this desktop-host method/);
  assert.match(commands, /recovery window cannot call this desktop-host method/);
  assert.match(commands, /desktop_renderer_heartbeat/);
  assert.match(commands, /explorer/);
  assert.match(instance, /flock/);
  assert.match(instance, /CreateMutexW/);
  assert.match(commands, /DSH_DESKTOP_SAFE_MODE/);
  const migration = fs.readFileSync(
    path.join(root, 'src-tauri', 'src', 'migration.rs'),
    'utf8',
  );
  assert.match(migration, /checksum_without_field/);
  assert.match(migration, /desktop_migration_complete/);
  assert.match(migration, /set_cookie/);
  assert.doesNotMatch(migration, /non-importable HttpOnly/);
  assert.match(migration, /http_only/);
});

test('Tauri Rust host manager contains the required process safety gates', () => {
  const host = fs.readFileSync(
    path.join(root, 'src-tauri', 'src', 'process', 'host.rs'),
    'utf8',
  );
  const fence = fs.readFileSync(
    path.join(root, 'src-tauri', 'src', 'process', 'fence.rs'),
    'utf8',
  );
  assert.match(host, /MAX_FRAME_BYTES/);
  assert.match(host, /validate_loopback_http_200/);
  assert.match(host, /ProcessFence::attach/);
  assert.match(fence, /0o600/);
  assert.match(fence, /SIGTERM/);
  assert.match(fence, /SIGKILL/);
  assert.match(fence, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
});

test('Tauri window contract preserves all five planned window roles', () => {
  const source = fs.readFileSync(
    path.join(root, 'shared', 'contract', 'windows.ts'),
    'utf8',
  );
  for (const role of ['main', 'float', 'wizard', 'update', 'recovery']) {
    assert.match(source, new RegExp(`['"]${role}['"]`));
  }
});
