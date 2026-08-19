import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8');

test('Linux 启动失败不触发自动客户端更新弹窗', () => {
  assert.match(
    mainSrc,
    /function scheduleClientUpdateRescue\(\) \{[\s\S]*?if \(!IS_WIN \|\|/,
    'Linux rescue must return before scheduling runClientUpdateFlow(true)',
  );
});

test('每轮服务启动前清空旧 webUrl', () => {
  const start = mainSrc.indexOf('function startAndShow(overlays = []) {');
  const launch = mainSrc.indexOf('return startServer(4, merged)', start);
  const clear = mainSrc.indexOf('webUrl = null;', start);
  assert.ok(start >= 0 && clear > start && clear < launch, 'startAndShow must clear webUrl before startServer');
});

test('页面加载成功后才把服务标记为 serving，避免启动/退出双弹窗', () => {
  assert.match(
    mainSrc,
    /return mainWindow\.loadURL\(url\)\.then\(\(\) => \{\s*webUrl = url;\s*return url;/,
  );
  assert.doesNotMatch(
    mainSrc,
    /\.then\(\(url\) => \{\s*webUrl = url;\s*log\('boot', 'Web UI 就绪:/,
  );
});

test('应用退出期间禁止启动新服务和启动失败恢复', () => {
  assert.match(
    mainSrc,
    /function startAndShow\(overlays = \[\]\) \{\s*if \(quitting\) return Promise\.reject/,
  );
  assert.match(
    mainSrc,
    /\.catch\(\(err\) => \{\s*if \(!quitting\) handleBootFailure\(err\);\s*\}\);\s*\}\s*\/\/ -+\s*\/\/ App lifecycle/,
  );
});

test('服务意外退出后清空地址并加载本地等待页', () => {
  assert.match(mainSrc, /const wasServing = Boolean\(webUrl\);\s*if \(!intentional && !handedOff\) webUrl = null;/);
  assert.match(
    mainSrc,
    /if \(!quitting && !intentional && !handedOff && wasServing[\s\S]*?mainWindow\.loadFile\(path\.join\(__dirname, 'assets', 'loading\.html'\)\)/,
  );
});
