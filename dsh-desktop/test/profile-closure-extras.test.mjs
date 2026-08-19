import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensureProfileClosureExtras } = require('../profile-closure-extras.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-extra-'));
  const home = join(root, 'home');
  const modules = join(root, 'app', 'node_modules');
  mkdirSync(join(modules, 'schemastery'), { recursive: true });
  writeFileSync(join(modules, 'schemastery', 'package.json'), JSON.stringify({ name: 'schemastery' }));
  return { root, home, modules };
}

test('links app-level dependencies into the profile fallback closure', () => {
  const f = fixture();
  try {
    const result = ensureProfileClosureExtras(f.home, f.modules, ['schemastery']);
    const link = join(f.home, 'profiles', 'node_modules', 'schemastery');
    assert.deepEqual(result, { linked: ['schemastery'], unavailable: [] });
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(join(link, 'package.json')), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('is idempotent and preserves an existing healthy fallback package', () => {
  const f = fixture();
  try {
    ensureProfileClosureExtras(f.home, f.modules, ['schemastery']);
    const second = ensureProfileClosureExtras(f.home, f.modules, ['schemastery']);
    assert.deepEqual(second, { linked: [], unavailable: [] });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('reports a missing app dependency without creating a dangling link', () => {
  const f = fixture();
  try {
    const result = ensureProfileClosureExtras(f.home, f.modules, ['missing-package']);
    assert.deepEqual(result, { linked: [], unavailable: ['missing-package'] });
    assert.equal(existsSync(join(f.home, 'profiles', 'node_modules', 'missing-package')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
