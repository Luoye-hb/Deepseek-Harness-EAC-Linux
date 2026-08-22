/**
 * Electron fallback composition for the desktop-host sidecar.
 *
 * The direct Electron server path remains the default during migration.
 * Setting DSH_DESKTOP_HOST_RPC=1 exercises the same dsh lifecycle through
 * the bundled Node host and framed stdio RPC.
 */

import * as path from 'node:path';
import { state } from './state.js';
import { log } from './log.js';
import { bridge } from './bridge.js';
import { desktopPlatform } from './desktop-platform.js';
import { app } from 'electron';
import { ElectronDesktopHostClient } from '../platform/electron-fallback/desktop-host-client.js';
import type { DshStartParams } from '../shared/contract/desktop-host.js';

let client: ElectronDesktopHostClient | null = null;
let restartDsh: (() => Promise<void>) | null = null;
let hostFailureDialogActive = false;

export function desktopHostRpcEnabled(): boolean {
  return process.env.DSH_DESKTOP_HOST_RPC === '1';
}

function hostEntryPath(): string {
  return path.join(__dirname, '..', 'desktop-host', 'main.js');
}

function currentClient(): ElectronDesktopHostClient | null {
  if (!client) return null;
  if (client.process.exitCode !== null || client.process.signalCode !== null) {
    client = null;
    return null;
  }
  return client;
}

function onHostNotify(event: string, payload: unknown): void {
  if (event !== 'dsh.exit') return;
  const details = (payload ?? {}) as {
    code?: unknown;
    signal?: unknown;
    intentional?: unknown;
    url?: unknown;
  };
  if (client && state.serverProc === client.process) state.serverProc = null;
  log(
    'dsh',
    `desktop-host dsh 退出 code=${String(details.code)} signal=${String(details.signal)} intentional=${String(details.intentional)}`,
  );
  if (
    details.intentional === true ||
    state.quitting ||
    !state.webUrl ||
    !state.mainWindow ||
    state.mainWindow.isDestroyed()
  ) {
    return;
  }
  const detail = `dsh web 进程退出（code=${String(details.code)} signal=${String(details.signal)}）`;
  bridge
    .showBox({
      type: 'error',
      title: 'DSH 服务已停止',
      message: 'DeepSeek Harness 服务意外退出。',
      detail,
      buttons: ['复制日志', '重新启动', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) void desktopPlatform.writeClipboard(detail);
      else if (response === 1) void restartDsh?.();
      else {
        app.quit();
      }
    })
    .catch((error: unknown) => {
      log('dsh', 'desktop-host 退出对话框失败: ' + String((error as Error).message));
    });
}

function onHostClosed(reason: string, owner: ElectronDesktopHostClient): void {
  const owned = client === owner;
  if (owned && state.serverProc === owner.process) state.serverProc = null;
  log('desktop-host', `host 连接关闭: ${reason}`);
  if (
    !owned ||
    hostFailureDialogActive ||
    state.quitting ||
    state.restartingServer ||
    !state.webUrl ||
    !state.mainWindow ||
    state.mainWindow.isDestroyed()
  ) {
    return;
  }
  hostFailureDialogActive = true;
  const detail = `desktop-host 进程意外退出：${reason}`;
  void bridge
    .showBox({
      type: 'error',
      title: '桌面服务已停止',
      message: '桌面服务宿主进程意外退出。',
      detail,
      buttons: ['复制日志', '重新启动', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) void desktopPlatform.writeClipboard(detail);
      else if (response === 1) void restartDsh?.();
      else app.quit();
    })
    .catch((error: unknown) => {
      log('desktop-host', 'host 退出对话框失败: ' + String((error as Error).message));
    })
    .finally(() => {
      hostFailureDialogActive = false;
    });
}

function ensureClient(nodePath: string): ElectronDesktopHostClient {
  const existing = currentClient();
  if (existing) return existing;
  const next = new ElectronDesktopHostClient({
    nodePath,
    entryPath: hostEntryPath(),
    cwd: state.userDataDir || process.cwd(),
    onNotify: onHostNotify,
    onStderr: (text) => log('desktop-host', text.trimEnd()),
    onClosed: (reason) => {
      onHostClosed(reason, next);
    },
  });
  client = next;
  return next;
}

export async function startDesktopHost(
  options: DshStartParams,
  onRestart?: () => Promise<void>,
): Promise<string> {
  restartDsh = onRestart ?? null;
  const next = ensureClient(options.nodePath);
  const result = await next.start(options);
  state.serverProc = next.process;
  state.webUrl = result.url;
  return result.url;
}

export async function stopDesktopHost(): Promise<void> {
  const current = client;
  client = null;
  if (state.serverProc === current?.process) state.serverProc = null;
  if (!current) return;
  try {
    await current.shutdown();
  } catch (error) {
    log('desktop-host', 'host 退出失败: ' + String((error as Error).message));
    current.kill();
  }
}

export function desktopHostProcess(): ElectronDesktopHostClient | null {
  return currentClient();
}
