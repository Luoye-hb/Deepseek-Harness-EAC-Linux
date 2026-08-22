import assert from 'node:assert/strict';
import test from 'node:test';

import { DropPathResolver } from '../platform/tauri/bridge/drop-paths.js';

test('Tauri drop path resolver associates native paths by file name and order', () => {
  const resolver = new DropPathResolver();
  const first = { name: 'README.md', size: 10 };
  const second = { name: 'main.ts', size: 20 };

  resolver.begin(['/workspace/main.ts', '/workspace/README.md']);
  resolver.associate([first, second]);

  assert.equal(resolver.resolve(first), '/workspace/README.md');
  assert.equal(resolver.resolve(second), '/workspace/main.ts');
  assert.equal(resolver.resolve({ name: 'main.ts' }), '');
});

test('Tauri drop path resolver clears the transaction cache', () => {
  const resolver = new DropPathResolver();
  const file = { name: 'notes.txt' };
  resolver.begin(['/tmp/notes.txt']);
  resolver.associate([file]);
  assert.equal(resolver.resolve(file), '/tmp/notes.txt');

  resolver.clear();
  assert.equal(resolver.resolve(file), '');
  assert.equal(resolver.resolve(null), '');
});
