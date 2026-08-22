import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { ensureProfileRuntimeClosure } from '../shared/desktop-core/profile-runtime.ts';

test('profile runtime closure links missing bundled packages and repairs dangling links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-runtime-'));
  const closure = path.join(root, 'closure');
  const dsh = path.join(closure, '@deepseek-ai', 'dsh');
  const home = path.join(root, 'home');
  const fallback = path.join(home, 'profiles', 'node_modules');
  const sourceSchemastery = path.join(closure, 'schemastery');
  const sourceDsh = path.join(dsh, 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(sourceDsh), { recursive: true });
  fs.writeFileSync(sourceDsh, '');
  fs.writeFileSync(path.join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  fs.mkdirSync(sourceSchemastery, { recursive: true });
  fs.writeFileSync(path.join(sourceSchemastery, 'package.json'), JSON.stringify({ name: 'schemastery' }));
  fs.mkdirSync(fallback, { recursive: true });
  fs.symlinkSync(path.join(root, 'missing'), path.join(fallback, 'schemastery'), 'dir');

  try {
    const result = ensureProfileRuntimeClosure(home, sourceDsh);
    assert.equal(result.ok, true);
    assert.ok(result.repaired.includes('schemastery'));
    assert.ok(result.linked.includes('@deepseek-ai/dsh'));
    assert.equal(
      fs.realpathSync(path.join(fallback, 'schemastery')),
      fs.realpathSync(sourceSchemastery),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profile runtime closure preserves an existing real fallback package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-runtime-real-'));
  const closure = path.join(root, 'closure');
  const dsh = path.join(closure, '@deepseek-ai', 'dsh');
  const home = path.join(root, 'home');
  const fallback = path.join(home, 'profiles', 'node_modules');
  fs.mkdirSync(path.join(dsh, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dsh, 'lib', 'bin.js'), '');
  fs.writeFileSync(path.join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  fs.mkdirSync(path.join(closure, 'react'), { recursive: true });
  fs.writeFileSync(path.join(closure, 'react', 'package.json'), JSON.stringify({ name: 'react' }));
  fs.mkdirSync(path.join(fallback, 'react'), { recursive: true });
  fs.writeFileSync(path.join(fallback, 'react', 'package.json'), JSON.stringify({ name: 'react', version: 'user' }));

  try {
    const result = ensureProfileRuntimeClosure(home, path.join(dsh, 'lib', 'bin.js'));
    assert.equal(result.ok, true);
    assert.ok(result.skipped.includes('react'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(fallback, 'react', 'package.json'), 'utf8')).version, 'user');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profile runtime closure repairs a healthy link owned by another closure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-runtime-foreign-'));
  const closure = path.join(root, 'closure');
  const foreign = path.join(root, 'foreign');
  const dsh = path.join(closure, '@deepseek-ai', 'dsh');
  const home = path.join(root, 'home');
  const fallback = path.join(home, 'profiles', 'node_modules');
  fs.mkdirSync(path.join(dsh, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dsh, 'lib', 'bin.js'), '');
  fs.writeFileSync(path.join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  fs.mkdirSync(path.join(closure, 'schemastery'), { recursive: true });
  fs.writeFileSync(path.join(closure, 'schemastery', 'package.json'), JSON.stringify({ name: 'schemastery' }));
  fs.mkdirSync(path.join(foreign, 'schemastery'), { recursive: true });
  fs.writeFileSync(path.join(foreign, 'schemastery', 'package.json'), JSON.stringify({ name: 'schemastery', version: 'foreign' }));
  fs.mkdirSync(fallback, { recursive: true });
  fs.symlinkSync(path.join(foreign, 'schemastery'), path.join(fallback, 'schemastery'), 'dir');

  try {
    const result = ensureProfileRuntimeClosure(home, path.join(dsh, 'lib', 'bin.js'));
    assert.equal(result.ok, true);
    assert.ok(result.repaired.includes('schemastery'));
    assert.equal(fs.realpathSync(path.join(fallback, 'schemastery')), fs.realpathSync(path.join(closure, 'schemastery')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
