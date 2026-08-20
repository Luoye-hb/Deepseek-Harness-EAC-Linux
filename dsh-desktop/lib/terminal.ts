/**
 * lib/terminal.ts — 内置 Node+npm 环境终端（Task 2.4 自 main.js 提取）。
 *
 * 启动一个「内置终端」：用随应用分发的 node.exe + npm CLI 拼出一个
 * cmd.exe 会话，PATH 前置内置 node 目录与临时垫片目录，使 node / npm /
 * npx 直接可用——无需用户本机预装 Node。
 *
 * 为什么要垫片：vendor/npm/bin 下自带的 npm.cmd / npx.cmd 期望在自身
 * 同级目录找到 node.exe 与 node_modules/npm/bin/npm-cli.js（npm 标准安装
 * 布局），而我们这里是把 npm 目录整体拷出（node.exe 在 vendor/node 下），
 * 自带的 .cmd 解析不到，故自写薄垫片直指内置 node.exe + npm-cli.js /
 * npx-cli.js。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { log } from './log.js';
import { nodeExe, npmCli } from './proc.js';
import { bridge } from './bridge.js';
import { state } from './state.js';
import {
  createTerminalShims, executableOnPath, selectLinuxTerminal,
} from './terminal-platform.js';

/** 打开内置终端窗口（找不到内置运行时时弹错误框并返回）。 */
export function openBuiltinTerminal(): void {
  const nodeExePath = nodeExe();
  const npmCliPath = npmCli();
  if (!fs.existsSync(nodeExePath) || !fs.existsSync(npmCliPath)) {
    void bridge
      .showBox({
        type: 'error',
        title: '内置终端',
        message: '未找到内置 Node/npm 运行时。',
        detail: `Node：${nodeExePath}\nnpm：${npmCliPath}`,
        buttons: ['确定'],
      })
      .catch(() => {});
    return;
  }
  let binDir: string;
  try {
    binDir = createTerminalShims(state.userDataDir, nodeExePath, npmCliPath).binDir;
  } catch (err) {
    log('terminal', '创建内置终端垫片失败: ' + String((err as Error).message));
    void bridge.showBox({
      type: 'error',
      title: '内置终端',
      message: '无法创建内置 Node/npm 命令。',
      detail: String((err as Error).message),
      buttons: ['确定'],
    }).catch(() => {});
    return;
  }

  // 读取内置 node 版本用于标题/横幅，失败则留空。
  let nodeVer = '';
  try {
    nodeVer = (
      (spawnSync(nodeExePath, ['-v'], { encoding: 'utf8', windowsHide: true }).stdout || '') as string
    ).trim();
  } catch {
    /* 版本读取失败不阻塞终端 */
  }

  const env = {
    ...process.env,
    PATH: [binDir, path.dirname(nodeExePath), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
  };
  const title =
    'Deepseek Harness EAC - 内置终端' + (nodeVer ? ' (Node ' + nodeVer + ')' : '');
  const banner =
    '[内置环境] ' +
    (nodeVer ? 'Node ' + nodeVer + ' + ' : '') +
    'npm 已就绪，可直接使用 node / npm / npx 命令。';
  try {
    if (process.platform !== 'win32') {
      const selected = selectLinuxTerminal(env.PATH);
      if (!selected) throw new Error('未找到 x-terminal-emulator、GNOME Terminal、Konsole 或 Xfce Terminal');
      const configuredShell = process.env.SHELL || '';
      const shellPath = configuredShell && fs.existsSync(configuredShell)
        ? configuredShell
        : executableOnPath('bash', env.PATH) ?? '/bin/sh';
      spawn(selected.executable, selected.adapter.args(shellPath), {
        cwd: os.homedir(),
        env,
        detached: true,
        stdio: 'ignore',
      }).unref();
      log('terminal', `已启动内置终端 adapter=${selected.adapter.command} binDir=${binDir} nodeVer=${nodeVer || '?'}`);
      return;
    }
    // GUI 进程无控制台；cmd.exe 创建独立窗口并与主进程解耦。
    spawn('cmd.exe', ['/K', 'title ' + title + ' & echo ' + banner], {
      cwd: os.homedir(),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
    log('terminal', '已启动内置终端 adapter=cmd.exe binDir=' + binDir + ' nodeVer=' + (nodeVer || '?'));
  } catch (err) {
    log('terminal', '启动内置终端失败: ' + String((err && (err as Error).message) || err));
    void bridge
      .showBox({
        type: 'error',
        title: '内置终端',
        message: '启动内置终端失败。',
        detail: String((err && (err as Error).message) || err),
        buttons: ['确定'],
      })
      .catch(() => {});
  }
}
