/**
 * Shell-neutral public API exposed as window.dshDesktop.
 *
 * The Electron implementation currently provides this API through preload.
 * The Tauri bridge must preserve these names and return semantics.
 */

import type { DesktopEventListener } from './events.js';

export type DesktopShell = 'electron' | 'tauri';

export type Unsubscribe = () => void;

export interface DesktopWindowControlsApi {
  minimize(): Promise<unknown>;
  toggleMaximize(): Promise<unknown>;
  close(): Promise<unknown>;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (isMax: boolean) => void): Unsubscribe;
}

export interface DesktopFilesApi {
  onDrop(cb: DesktopEventListener<'files.drop'>): Unsubscribe;
}

export interface ChromeInfo {
  appVersion?: string;
  agentVersion?: string;
  agentSource?: string;
  desktopShell?: DesktopShell;
  notifyOnTurnEnd?: boolean;
  closeToTray?: boolean;
  exitAction?: string;
  shortcutPolicy?: string;
  repoUrls?: { github?: string; gitee?: string };
  iconDataUri?: string;
  [key: string]: unknown;
}

export interface DshDesktopApi {
  appVersion: string;
  windowControls: DesktopWindowControlsApi;
  menu: {
    action(action: string, payload?: Record<string, unknown>): Promise<unknown>;
  };
  getInfo(): Promise<ChromeInfo | null>;
  refreshBalance(): Promise<unknown>;
  restartService(): Promise<unknown>;
  floatWindow: {
    open(sessionId: string): Promise<unknown>;
    close(): void;
  };
  guard: {
    action(action: string, value?: unknown): Promise<unknown>;
  };
  pluginWizard: {
    open(): Promise<unknown>;
  };
  pluginManager: {
    list(): Promise<unknown>;
    setEnabled(id: string, enabled: boolean): Promise<unknown>;
    setRemoved(id: string, removed: boolean): Promise<unknown>;
  };
  pluginUpdates: {
    list(force?: boolean): Promise<unknown>;
    update(id: string): Promise<unknown>;
    setAutoUpdate(enabled: boolean): Promise<unknown>;
  };
  imagePaste: {
    save(payload: unknown): Promise<unknown>;
  };
  balancePrices: {
    get(model: string): Promise<unknown>;
    set(model: string, prices: unknown): Promise<unknown>;
    reset(model: string): Promise<unknown>;
  };
  revertFiles(changes: unknown): Promise<unknown>;
  openPath(path: string): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  copyText(text: string): Promise<{ ok?: boolean } | null>;
  getPathForFile(file: unknown): string;
  files: DesktopFilesApi;
  recovery: {
    getState(): Promise<unknown>;
    reload(): Promise<unknown>;
    restart(): Promise<unknown>;
    exportLogs(): Promise<unknown>;
  };
}
