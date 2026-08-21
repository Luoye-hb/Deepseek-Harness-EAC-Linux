import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

test('loading page reads the packaged app version through the preload bridge', () => {
  const src = readFileSync(join(ROOT, 'assets', 'loading.html'), 'utf8');
  assert.doesNotMatch(src, /Deepseek Harness EAC v1\.0/);
  assert.match(src, /id="version"/);
  assert.match(src, /window\.dshDesktop\.getInfo\(\)/);
  assert.match(src, /info\.appVersion/);
  assert.match(src, /document\.title = 'Deepseek Harness EAC ' \+ label/);
});

test('mobile-fix keeps long workspace names wrapped and row actions visible', () => {
  const src = readFileSync(
    join(ROOT, 'assets', 'plugins', 'dsh-web-mobile-fix', 'lib', 'client.js'),
    'utf8',
  );
  assert.match(src, /\.YDXeBa_projectRow \{ height: auto !important; min-height: 34px; \}/);
  assert.match(src, /\.YDXeBa_projectText \{ min-width: 0 !important; flex: 1 1 auto !important;/);
  assert.match(src, /\.YDXeBa_title \{ white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important;/);
});
