#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, '.tauri-staging');
const cargoTarget = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, 'src-tauri', 'target');

// Tauri keeps resource copies in these generated paths between builds. Clear
// only AppImage/resource caches so a fresh staging tree cannot inherit native
// files from an earlier platform or failed bundle.
for (const relative of [
  path.join(cargoTarget, 'release', '_up_'),
  path.join(cargoTarget, 'release', 'bundle', 'appimage'),
  path.join(cargoTarget, 'release', 'bundle', 'appimage_deb'),
]) {
  fs.rmSync(relative, { recursive: true, force: true });
}

const resources = [
  'desktop-host',
  'shared',
  'lib',
  'scripts',
  'balance.js',
  'logger.js',
  'updater.js',
  'plugin-updater.js',
  'session-watcher.js',
  'patch-row-heal.js',
  'plugin-guard.js',
  'plugin-manager-state.js',
  'settings.js',
  'client-updater.js',
  'package.json',
  'node_modules',
  'assets/plugins',
  'vendor/node',
  'vendor/npm',
  'packaging/LICENSE-MIT.txt',
];

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

for (const relative of resources) {
  const source = path.join(root, relative);
  const destination = path.join(staging, relative);
  if (!fs.existsSync(source)) {
    throw new Error(`Tauri staging source is missing: ${relative}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

// The source install also contains Electron and build-time dependencies. Remove
// them from the generated tree without changing the developer checkout.
const stagedPackagePath = path.join(staging, 'package.json');
const stagedPackage = JSON.parse(fs.readFileSync(stagedPackagePath, 'utf8'));
delete stagedPackage.devDependencies;
fs.writeFileSync(stagedPackagePath, JSON.stringify(stagedPackage, null, 2) + '\n', 'utf8');
const npmCommand = process.env.npm_execpath
  ? process.execPath
  : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];
execFileSync(npmCommand, [...npmArgs, 'prune', '--omit=dev', '--ignore-scripts', '--prefix', staging], {
  cwd: root,
  stdio: 'inherit',
});

// The Tauri artifact must not carry the Electron shell or its builder chain.
// Keep the source worktree intact; only the generated staging tree is pruned.
const electronOnly = [
  'electron',
  'electron-builder',
  'electron-publish',
  'app-builder-lib',
  'builder-util',
  'builder-util-runtime',
  '7zip-bin',
  'dmg-builder',
  'electron-to-chromium',
  'electron-winstaller',
  'electron-builder-squirrel-windows',
  '@electron',
  '@electron-internal',
  '@tauri-apps/cli',
  '@tauri-apps',
  'typescript',
  'esbuild',
  '@types',
];
for (const relative of electronOnly) {
  fs.rmSync(path.join(staging, 'node_modules', relative), { recursive: true, force: true });
}

// Keep only native artifacts for the current distribution target. The source
// install can contain optional prebuilds for other operating systems/arches.
const keepPrebuild = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
function prunePrebuildDirectories(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === 'prebuilds') {
      for (const prebuild of fs.readdirSync(entryPath)) {
        if (prebuild !== keepPrebuild) {
          fs.rmSync(path.join(entryPath, prebuild), { recursive: true, force: true });
        }
      }
      continue;
    }
    if (entry.isDirectory()) prunePrebuildDirectories(entryPath);
  }
}
prunePrebuildDirectories(path.join(staging, 'node_modules'));
const conptyRoot = path.join(staging, 'node_modules', 'node-pty', 'third_party', 'conpty');
if (process.platform !== 'win32') {
  fs.rmSync(conptyRoot, { recursive: true, force: true });
} else if (fs.existsSync(conptyRoot)) {
  const version = fs.readdirSync(conptyRoot)[0];
  if (version) {
    const conptyVersion = path.join(conptyRoot, version);
    for (const entry of fs.readdirSync(conptyVersion)) {
      if (entry !== 'win10-x64') fs.rmSync(path.join(conptyVersion, entry), { recursive: true, force: true });
    }
  }
}

// npm can leave command shims behind after pruning. Drop shims whose targets
// no longer exist so the package cannot expose a stale Electron command.
for (const binDir of [
  path.join(staging, 'node_modules', '.bin'),
  path.join(staging, 'vendor', 'npm', 'node_modules', '.bin'),
]) {
  if (!fs.existsSync(binDir)) continue;
  for (const entry of fs.readdirSync(binDir)) {
    const entryPath = path.join(binDir, entry);
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink()) {
        fs.realpathSync(entryPath);
      }
    } catch {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

// npm may recreate nested command shims that point back into the source
// checkout. Tauri would otherwise follow those links and package the entire
// source dependency tree alongside the intended staging tree.
function removeExternalSymlinks(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const realPath = fs.realpathSync(entryPath);
        if (realPath !== staging && !realPath.startsWith(staging + path.sep)) {
          fs.rmSync(entryPath, { force: true });
        }
      } catch {
        fs.rmSync(entryPath, { force: true });
      }
      continue;
    }
    if (entry.isDirectory()) removeExternalSymlinks(entryPath);
  }
}
removeExternalSymlinks(staging);

const node = path.join(staging, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const npmCli = path.join(staging, 'vendor', 'npm', 'bin', 'npm-cli.js');
const host = path.join(staging, 'desktop-host', 'main.js');
const dsh = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
for (const [label, file] of [['Node', node], ['npm', npmCli], ['desktop-host', host], ['DSH', dsh]]) {
  if (!fs.existsSync(file)) throw new Error(`Tauri staging ${label} payload is missing: ${file}`);
}
if (process.platform !== 'win32') fs.chmodSync(node, 0o755);

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* Source archives may not contain a Git checkout. */
}
fs.writeFileSync(
  path.join(staging, 'staging-manifest.json'),
  JSON.stringify({ schemaVersion: 1, commit, resources, excluded: electronOnly }, null, 2) + '\n',
  'utf8',
);
console.log(`Tauri staging ready: ${path.relative(root, staging)} (commit ${commit})`);
