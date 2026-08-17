'use strict';

// DSH_HOME 统一解析（全仓库唯一实现）。
//
// dsh CLI 的规则：DSH_HOME 环境变量显式覆盖，否则默认 ~/.dsh，桌面端与
// CLI 共享配置和会话。主进程里所有拼 DSH_HOME 子路径的地方（余额查询、
// 插件同步、会话监听、路径围栏、市场排队任务）都必须走这一个函数——
// 此前 main.js 里存在「dshHome || 默认值」与「process.env.DSH_HOME || 默认值」
// 两种写法散布 6 处，一旦某一处漏改就会出现两个 home 漂移的隐患。

const os = require('node:os');
const path = require('node:path');

function dshHomePath() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

module.exports = { dshHomePath };
