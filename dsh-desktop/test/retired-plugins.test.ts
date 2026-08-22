import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireRemovedBuiltinPlugins } from '../lib/retired-plugins.js';

test('retired plugins are absent from source assets and the companion registry', () => {
  const root = join(import.meta.dirname, '..');
  assert.equal(existsSync(join(root, 'assets', 'plugins', 'dsh-tdai-memory')), false);
  assert.equal(existsSync(join(root, 'assets', 'plugins', 'dsh-auto-compact')), false);
  const registry = readFileSync(join(root, 'lib', 'plugin-registry-data.ts'), 'utf8');
  assert.doesNotMatch(registry, /dsh-tdai-memory|dsh-auto-compact/);
  const marketRoot = join(root, 'assets', 'plugins', 'zat-dsh-engine');
  for (const file of ['data/zh-intro.json', 'data/kinds.json', 'lib/index.js']) {
    assert.doesNotMatch(readFileSync(join(marketRoot, file), 'utf8'), /dsh-tdai-memory/i);
  }
});

test('retired plugin cleanup removes rows, packages, dependencies, bundles, and marker names', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-retired-'));
  try {
    mkdirSync(join(profile, 'node_modules', 'dsh-tdai-memory'), { recursive: true });
    mkdirSync(join(profile, 'node_modules', 'dsh-auto-compact'), { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: tdai-memory',
      "      name: 'dsh-tdai-memory'",
      '- insert:',
      '    - id: compact',
      "      name: 'dsh-compact'",
      '- insert:',
      '    - id: auto-compact',
      "      name: 'dsh-auto-compact'",
      '',
    ].join('\n'));
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-tdai-memory': 'link:old', 'dsh-auto-compact': 'link:old', 'dsh-compact': 'link:new' },
      dsh: { profile: { bundles: ['dsh-tdai-memory', 'dsh-auto-compact', 'dsh-compact'] } },
    }));
    writeFileSync(join(profile, '.dsh-builtin-plugins.json'), JSON.stringify({
      names: ['dsh-tdai-memory', 'dsh-auto-compact', 'dsh-compact'],
    }));

    const result = retireRemovedBuiltinPlugins(profile);
    assert.deepEqual(result.rows.sort(), ['auto-compact', 'tdai-memory']);
    assert.equal(existsSync(join(profile, 'node_modules', 'dsh-tdai-memory')), false);
    assert.equal(existsSync(join(profile, 'node_modules', 'dsh-auto-compact')), false);
    assert.match(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), /id: compact/);
    assert.doesNotMatch(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), /tdai-memory|auto-compact/);

    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, { 'dsh-compact': 'link:new' });
    assert.deepEqual(manifest.dsh.profile.bundles, ['dsh-compact']);
    assert.deepEqual(JSON.parse(readFileSync(join(profile, '.dsh-builtin-plugins.json'), 'utf8')).names, ['dsh-compact']);
    assert.deepEqual(retireRemovedBuiltinPlugins(profile), { rows: [], packages: [], manifests: [] });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
