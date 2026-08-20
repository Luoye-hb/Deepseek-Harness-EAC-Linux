import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

test('Windows CI and release use Node 24 and exclude Linux release tags', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');
  assert.match(ci, /node-version: 24\.19\.0/);
  assert.match(release, /node-version: 24\.19\.0/);
  assert.match(release, /- '!\*-linux'/);
  assert.match(release, /npm run dist/);
});

test('Linux CI builds on Debian 12 with official Node and audits four formats', () => {
  const workflow = read('.github/workflows/linux.yml');
  assert.match(workflow, /image: debian:12/);
  assert.match(workflow, /node-v24\.19\.0-linux-x64\.tar\.xz/);
  assert.match(workflow, /SHASUMS256\.txt/);
  assert.match(workflow, /npm rebuild node-pty --build-from-source/);
  assert.match(workflow, /npm run dist:linux/);
  for (const extension of ['pacman', 'deb', 'rpm', 'AppImage']) {
    assert.match(workflow, new RegExp(`dist/\\*\\.${extension}`));
  }
  assert.match(workflow, /audit-linux-package\.sh/);
  assert.match(workflow, /tags:[\s\S]*- '\*-linux'/);
  assert.match(workflow, /make_latest: false/);
});

test('support documentation limits releases and records Linux boundaries', () => {
  const matrix = read('docs/support-matrix.md');
  const vnext = read('vnext-plugin-isolation-architecture.md');
  assert.match(matrix, /Windows x64 and Linux x86_64/);
  assert.match(matrix, /macOS[\s\S]*Unsupported/);
  assert.match(matrix, /GLIBC_2\.34/);
  assert.match(matrix, /cgroup v2 boundary/);
  assert.match(matrix, /AppImage is replaced manually/);
  assert.match(vnext, /Node v24\.19\.0/);
  assert.match(vnext, /Linux Fence/);
  assert.match(vnext, /`updater\.ts`/);
});
