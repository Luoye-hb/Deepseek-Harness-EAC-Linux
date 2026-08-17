import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { configLinesFor, healSoulMdPatchRow, healRowConfig, removeBundledRowDuplicates, bundlePatchEntryIds, collectBundleEntryIds } = require(join(root, 'patch-row-heal.js'));

// v2.0.0 实际写进用户 profile 的坏行：只有 id + name，没有 config。
const BROKEN_PATCH = [
  '# dsh web profile patch（由 DSH Desktop 维护）',
  '- insert:',
  '    - id: soul-md',
  "      name: 'dsh-soul-md'",
  '- insert:',
  '    - id: tdai-memory',
  "      name: 'dsh-tdai-memory'",
  '',
].join('\n');

test('healSoulMdPatchRow 补上缺失的 config.path（v2.0.0 存量坏行）', () => {
  const { patch, healed } = healSoulMdPatchRow(BROKEN_PATCH);
  assert.deepEqual(healed, ['soul-md']);
  assert.match(patch, /- id: soul-md\n\s*name: 'dsh-soul-md'\n\s*config:\n\s*path: "soul\.md"\n/);
  // 其他行不受影响
  assert.match(patch, /- id: tdai-memory\n\s*name: 'dsh-tdai-memory'\n/);
  assert.equal(patch.match(/- id: soul-md/g).length, 1, '不应重复插入行');
});

test('healSoulMdPatchRow 幂等：已有 config 的行不再改动', () => {
  const once = healSoulMdPatchRow(BROKEN_PATCH).patch;
  const twice = healSoulMdPatchRow(once);
  assert.deepEqual(twice.healed, []);
  assert.equal(twice.patch, once);
});

test('healSoulMdPatchRow 对无 soul-md 行 / 空内容安全', () => {
  assert.deepEqual(healSoulMdPatchRow('- insert:\n    - id: tool-vision\n').healed, []);
  assert.deepEqual(healSoulMdPatchRow('').healed, []);
});

test('configLinesFor 生成合法 patch YAML', () => {
  assert.equal(configLinesFor({ path: 'soul.md' }), '      config:\n        path: "soul.md"\n');
});

// 根因防回归：schema 的 path 必须有默认值（文件缺失 → fallback 空 → 不注册
// section，官方提示词原样使用），绝不能再变回 required 无默认。
test('dsh-soul-md schema: path 带默认值，不再是 required', () => {
  const src = readFileSync(join(root, 'assets', 'plugins', 'dsh-soul-md', 'index.js'), 'utf8');
  assert.match(src, /path:\s*z\.string\(\)\.default\(/, 'path 必须带 .default()');
  assert.doesNotMatch(src, /path:\s*z\.string\(\)\.required\(\)/, 'path 不能是 required 无默认');
});

// main.js 侧双保险：新增行必须显式写 config，且启动时 heal 存量坏行。
test('main.js: soul-md 行带 config + 启动时执行存量 heal', () => {
  const src = readFileSync(join(root, 'main.js'), 'utf8');
  assert.match(src, /id:\s*'soul-md',[^\n]*config:\s*\{\s*path:\s*'soul\.md'\s*\}/);
  assert.match(src, /healSoulMdPatchRow\(patch\)/);
  assert.match(src, /block \+= configLinesFor\(p\.config\)/);
});

// 市场安装（dsh plugin add 登记 bundles）与 overlay 写行双挂载 →
// "duplicate loader entry id" 拖垮插件树。overlay 重复行必须被移除。
test('removeBundledRowDuplicates: 删 bundle 已登记的 overlay 行', () => {
  const patch = [
    '- insert:',
    '    - id: soul-md',
    "      name: 'dsh-soul-md'",
    '      config:',
    '        path: "soul.md"',
    '- insert:',
    '    - id: mobile-fix',
    "      name: 'dsh-web-mobile-fix'",
    '- insert:',
    '    - id: terminal',
    "      name: '@deepseek-ai/dsh-terminal'",
    '',
  ].join('\n');
  const rowIds = { 'soul-md': 'dsh-soul-md', 'mobile-fix': 'dsh-web-mobile-fix', terminal: '@deepseek-ai/dsh-terminal' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-web-mobile-fix']);
  assert.deepEqual(removed, ['mobile-fix']);
  assert.doesNotMatch(out, /mobile-fix/);
  assert.match(out, /- id: soul-md[\s\S]*path: "soul\.md"/, '相邻块的 config 完整保留');
  assert.match(out, /- id: terminal/);
});

test('removeBundledRowDuplicates: 无 bundle 登记时不动任何行', () => {
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { patch: out, removed } = removeBundledRowDuplicates(BROKEN_PATCH, rowIds, []);
  assert.deepEqual(removed, []);
  assert.equal(out, BROKEN_PATCH);
});

test('removeBundledRowDuplicates: 非 uninstall 目标插件（tts 等）不受影响', () => {
  const patch = '- insert:\n    - id: tts\n      name: \'@dsh-external/dsh-plugin-tts\'\n';
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { removed } = removeBundledRowDuplicates(patch, rowIds, ['@dsh-external/dsh-plugin-tts']);
  assert.deepEqual(removed, [], 'rowIds 不含 tts，即使 bundle 里有也不动');
});

// issue #16：git/fork/link 安装的 bundle 包名与 overlay 行包名不一致，
// 但 entry id 相同 —— 旧「按包名匹配」删不掉，必须按 id 去重。
test('removeBundledRowDuplicates: 按 bundle 声明的 entry id 去重（跨包名，issue #16）', () => {
  const patch = [
    '- insert:',
    '    - id: tool-vision',
    "      name: 'dsh-tool-vision'",
    '- insert:',
    '    - id: tdai-memory',
    "      name: 'dsh-tdai-memory'",
    '',
  ].join('\n');
  const rowIds = { 'tool-vision': 'dsh-tool-vision', 'tdai-memory': 'dsh-tdai-memory' };
  // bundle 是 git fork：包名 dsh-vision-local，但包内 patch 声明 id: tool-vision。
  const bundleEntryIds = new Set(['tool-vision']);
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-vision-local'], bundleEntryIds);
  assert.deepEqual(removed, ['tool-vision']);
  assert.doesNotMatch(out, /tool-vision/);
  assert.match(out, /- id: tdai-memory/, '无关行保留');
});

test('removeBundledRowDuplicates: bundleEntryIds 为空时退化为原有按包名行为', () => {
  const patch = '- insert:\n    - id: mobile-fix\n      name: \'dsh-web-mobile-fix\'\n';
  const rowIds = { 'mobile-fix': 'dsh-web-mobile-fix' };
  const { patch: out, removed } = removeBundledRowDuplicates(patch, rowIds, ['dsh-web-mobile-fix'], new Set());
  assert.deepEqual(removed, ['mobile-fix']);
  assert.doesNotMatch(out, /mobile-fix/);
});

// 收集函数：从 bundle 包目录解析 patch 声明的 entry id（含 dsh.bundle.patch 指向）。
test('bundlePatchEntryIds / collectBundleEntryIds: 解析包内 patch 的 entry id', () => {
  const dir = join(root, 'tmp-test-patch-heal', 'node_modules');
  const pkgDir = join(dir, 'dsh-vision-local');
  const fs = require('node:fs');
  fs.mkdirSync(pkgDir, { recursive: true });
  try {
    fs.writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-vision-local',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }));
    fs.writeFileSync(join(pkgDir, 'cordis.patch.yml'),
      '- insert:\n    - id: tool-vision\n      name: \'dsh-vision-local\'\n');
    const ids = collectBundleEntryIds(['dsh-vision-local'], dir);
    assert.deepEqual([...ids], ['tool-vision']);
    assert.equal(bundlePatchEntryIds(pkgDir).has('tool-vision'), true);
  } finally {
    fs.rmSync(join(root, 'tmp-test-patch-heal'), { recursive: true, force: true, maxRetries: 5 });
  }
});

// V4：dsh-pet 无 config 行的存量修复（v3.1.0 全新安装即崩的根因）。
test('healRowConfig 给缺 config 的 dsh-pet 行补包默认 config', () => {
  const bad = "- insert:\n    - id: dsh-pet\n      name: 'dsh-pet'\n";
  const { patch, healed } = healRowConfig(bad, 'dsh-pet', { size: 260, position: 'bottom-right' });
  assert.ok(healed.includes('dsh-pet'));
  assert.match(patch, /id: dsh-pet\n\s+name: 'dsh-pet'\n\s+config:\n\s+size: 260\n\s+position: "bottom-right"/);
});

test('healRowConfig 幂等且不碰相邻行', () => {
  const bad = "- insert:\n    - id: navbar\n      name: 'n'\n- insert:\n    - id: dsh-pet\n      name: 'dsh-pet'\n";
  const once = healRowConfig(bad, 'dsh-pet', { size: 260, position: 'bottom-right' });
  const twice = healRowConfig(once.patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
  assert.equal(twice.patch, once.patch, '二次 heal 不应再改动');
  assert.ok(once.patch.includes("id: navbar"));
});
