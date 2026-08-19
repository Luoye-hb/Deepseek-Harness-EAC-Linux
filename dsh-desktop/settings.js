'use strict';

// 应用设置存储（<userData>/settings.json）。
//
// 端口、托盘、余额价格、更新跳过状态等全应用设置都读写这里。此前这组
// 函数住在 updater.js 里，导致「agent 自更新引擎」与「全局设置存储」耦合
// 在一起（改余额价格显示也要碰更新器）；剥离为独立模块后，updater.js
// 只保留更新逻辑，其余模块按需引用。

const path = require('node:path');
const fs = require('node:fs');

function settingsPath(ctx) { return path.join(ctx.userDataDir, 'settings.json'); }

function loadSettings(ctx) {
  try { return JSON.parse(fs.readFileSync(settingsPath(ctx), 'utf8')); }
  catch { return {}; }
}

function saveSettings(ctx, s) {
  try { fs.writeFileSync(settingsPath(ctx), JSON.stringify(s, null, 2) + '\n'); }
  catch (err) { ctx.log('settings', '保存 settings 失败: ' + err.message); }
}

module.exports = { settingsPath, loadSettings, saveSettings };
