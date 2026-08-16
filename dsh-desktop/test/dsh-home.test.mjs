// dsh-home.js 契约测试：DSH_HOME 解析的全仓库唯一实现。
//
// 此前 main.js 里存在「dshHome || 默认值」与「process.env.DSH_HOME || 默认值」
// 两种写法散布 6 处；余额查询、插件同步、会话监听等路径一旦与后端启动用
// 的 home 漂移，就会出现「设置了 DSH_HOME 但部分功能读写 ~/.dsh」的错位。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { dshHomePath } from '../dsh-home.js';

test('explicit DSH_HOME env override wins', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/custom-dsh-home';
  try {
    assert.equal(dshHomePath(), '/tmp/custom-dsh-home');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('without override, falls back to ~/.dsh (shares config with the CLI)', () => {
  const prev = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    assert.equal(dshHomePath(), path.join(os.homedir(), '.dsh'));
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev;
  }
});
