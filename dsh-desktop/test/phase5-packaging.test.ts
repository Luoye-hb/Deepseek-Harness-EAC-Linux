import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(import.meta.dirname, '..');
const localRequire = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  desktopName?: string;
  scripts: Record<string, string>;
};
const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');

test('Linux packaging exposes four x64 targets and no macOS target', () => {
  for (const [script, target] of [
    ['dist:arch', 'pacman'],
    ['dist:deb', 'deb'],
    ['dist:rpm', 'rpm'],
    ['dist:appimage', 'AppImage'],
  ]) {
    assert.match(packageJson.scripts[script] || '', new RegExp(`--linux ${target} --x64`, 'i'));
  }
  assert.match(packageJson.scripts['dist:linux'] || '', /--linux --x64/);
  assert.equal(packageJson.desktopName, 'deepseek-harness-eac');
  assert.match(builder, /syncDesktopName: true/);
  assert.doesNotMatch(builder, /^mac:/m);
  for (const target of ['pacman', 'deb', 'rpm', 'AppImage']) {
    assert.match(builder, new RegExp(`target: ${target}`));
  }
});

test('builder resources isolate runtimes and Windows supervisor by platform', () => {
  assert.match(builder, /win:[\s\S]*from: vendor\/node\/node\.exe[\s\S]*from: native\/supervisor\/index\.node/);
  assert.match(builder, /linux:[\s\S]*from: vendor\/node\/node\n[\s\S]*target:/);
  const filesBlock = builder.slice(builder.indexOf('files:'), builder.indexOf('extraResources:'));
  assert.doesNotMatch(filesBlock, /native\/supervisor\/index\.node/);
  assert.match(builder, /asar: false/);
  assert.match(builder, /npmRebuild: false/);
  assert.match(builder, /buildDependenciesFromSource: false/);
});

test('runtime fetch pins official Node and removes the stale opposite executable', () => {
  const source = readFileSync(join(root, 'scripts', 'fetch-node.ts'), 'utf8');
  assert.match(source, /NODE_VERSION = 'v24\.19\.0'/);
  assert.match(source, /SHASUMS256\.txt/);
  assert.match(source, /SHA-256 mismatch/);
  assert.match(source, /fs\.rmSync\(path\.join\(runtimeDir, process\.platform === 'win32' \? 'node' : 'node\.exe'/);
  assert.match(source, /Windows\/Linux x64 only/);
});

test('afterPack is cross-platform and Windows path surgery stays guarded', () => {
  const source = readFileSync(join(root, 'scripts', 'after-pack.ts'), 'utf8');
  assert.doesNotMatch(source, /electronPlatformName !== 'win32'\) return/);
  assert.match(source, /electronPlatformName === 'win32'[\s\S]*trimLongPathFiles\(appOutDir\);[\s\S]*dedupeNestedModules\(appOutDir\);/);
  assert.match(source, /auditNodePty\(appOutDir, electronPlatformName\)/);
  assert.match(source, /auditBundledPluginRuntime\(pluginsDest, electronPlatformName\)/);
  assert.match(source, /closeAndVerifyNpm\(appOutDir, dest, electronPlatformName\)/);
  assert.match(source, /npm bundled dependency cannot be resolved/);
  assert.match(source, /mandatory .* is missing/);
});

test('Koffi runtime probe loads the platform system library', () => {
  const source = readFileSync(join(root, 'scripts', 'koffi-preflight.cjs'), 'utf8');
  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /kernel32\.dll/);
  assert.match(source, /libc\.so\.6/);
  assert.match(source, /GetCurrentProcessId/);
  assert.match(source, /getpid/);
});

test('GLIBC checker parses versions, compares numerically, and fails closed', () => {
  const checker = localRequire(join(root, 'scripts', 'check-glibc.cjs')) as {
    compareVersion(a: number[], b: number[]): number;
    inspectFile(file: string, spawn: () => object): { error: string | null };
    parseGlibcVersions(output: string): number[][];
  };
  assert.deepEqual(checker.parseGlibcVersions('GLIBC_2.3 GLIBC_2.34 GLIBC_2.9'), [[2, 3], [2, 9], [2, 34]]);
  assert.ok(checker.compareVersion([2, 35], [2, 34]) > 0);
  const result = checker.inspectFile(process.execPath, () => ({ error: new Error('missing') }));
  assert.match(result.error || '', /objdump unavailable/);
});

test('archive auditor rejects missing packages and unsupported formats', () => {
  const script = join(root, 'scripts', 'audit-linux-package.sh');
  const source = readFileSync(script, 'utf8');
  assert.match(source, /rpm --dbpath "\$rpm_db" -qp/);
  const missing = spawnSync('bash', [script, join(root, 'does-not-exist.deb')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /package is not a file/);
  const unsupported = spawnSync('bash', [script, join(root, 'package.json')], { encoding: 'utf8' });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /unsupported package format/);
});
