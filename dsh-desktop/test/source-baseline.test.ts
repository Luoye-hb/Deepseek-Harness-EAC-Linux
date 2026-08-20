import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');

test('strict TypeScript baseline stays pinned to Node 24', () => {
  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: { strict?: boolean; allowJs?: boolean };
  };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  assert.equal(tsconfig.compilerOptions?.strict, true);
  assert.equal(tsconfig.compilerOptions?.allowJs, false);
  assert.match(pkg.devDependencies?.['@types/node'] ?? '', /^24\./);
});

test('updater source remains below the 600-line gate', () => {
  const lines = readFileSync(join(root, 'updater.ts'), 'utf8').split(/\r?\n/).length;
  assert.ok(lines <= 600, `updater.ts has ${lines} lines`);
});

test('no generated first-party JavaScript is tracked', () => {
  const missingSources: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (name.endsWith('.js') && !existsSync(file.slice(0, -3) + '.ts')) missingSources.push(file);
    }
  };
  for (const dir of ['lib', 'shared', 'preload', 'scripts']) walk(join(root, dir));
  for (const name of readdirSync(root)) {
    if (name.endsWith('.js') && !existsSync(join(root, name.slice(0, -3) + '.ts'))) missingSources.push(join(root, name));
  }
  assert.deepEqual(missingSources, []);
});

test('the accidentally restored OpenClaw bridge is absent', () => {
  assert.equal(existsSync(join(root, 'assets', 'plugins', 'dsh-openclaw-bridge', 'package.json')), false);
  assert.doesNotMatch(readFileSync(join(root, 'lib', 'plugin-registry-data.ts'), 'utf8'), /dsh-openclaw-bridge/);
});
