/**
 * Electron fallback implementation of the shell-neutral desktop platform.
 *
 * This adapter is intentionally kept below the shared contract. It provides
 * the first injectable boundary for the later Tauri/Rust implementation while
 * the existing Electron window and IPC modules are migrated incrementally.
 */

import {
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Notification,
  shell,
} from 'electron';
import type {
  BrowserWindowConstructorOptions,
  MessageBoxOptions,
  NotificationConstructorOptions,
} from 'electron';
import type {
  DesktopDialogOptions,
  DesktopDialogResult,
  DesktopNotificationOptions,
  DesktopOs,
  DesktopPlatform,
  DesktopShortcut,
  DesktopWindow,
  DesktopWindowRole,
  DesktopWindowSpec,
} from '../../shared/contract/desktop-platform.js';
import type { DesktopShell, Unsubscribe } from '../../shared/contract/desktop-api.js';

export interface ElectronPlatformDependencies {
  readonly BrowserWindow: typeof BrowserWindow;
  readonly clipboard: Pick<typeof clipboard, 'writeText'>;
  readonly dialog: Pick<typeof dialog, 'showMessageBox'>;
  readonly globalShortcut: Pick<typeof globalShortcut, 'register' | 'unregister'>;
  readonly Notification: typeof Notification;
  readonly shell: Pick<typeof shell, 'openExternal' | 'openPath' | 'showItemInFolder'>;
}

export interface ElectronDesktopPlatformOptions {
  readonly dependencies?: Partial<ElectronPlatformDependencies>;
  readonly windowDefaults?: BrowserWindowConstructorOptions;
}

const defaultDependencies: ElectronPlatformDependencies = {
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Notification,
  shell,
};

function mergeDefined<T extends object>(base: T, extra: Partial<T>): T {
  return { ...base, ...extra };
}

function windowOptionsForSpec(
  spec: DesktopWindowSpec,
  defaults: BrowserWindowConstructorOptions,
): BrowserWindowConstructorOptions {
  const options: BrowserWindowConstructorOptions = mergeDefined(defaults, {
    width: spec.width ?? 1400,
    height: spec.height ?? 900,
    show: false,
    title: spec.title ?? 'Deepseek Harness EAC',
    ...(spec.resizable === undefined ? {} : { resizable: spec.resizable }),
    ...(spec.frameless === undefined ? {} : { frame: !spec.frameless }),
  });
  return options;
}

class ElectronDesktopWindow implements DesktopWindow {
  readonly id: string;
  readonly role: DesktopWindowRole;
  readonly nativeWindow: BrowserWindow;
  private readonly onClosed: () => void;

  constructor(
    nativeWindow: BrowserWindow,
    role: DesktopWindowRole,
    onClosed: () => void,
  ) {
    this.nativeWindow = nativeWindow;
    this.id = String(nativeWindow.id);
    this.role = role;
    this.onClosed = onClosed;
    nativeWindow.once('closed', onClosed);
  }

  show(): void {
    if (!this.nativeWindow.isDestroyed()) this.nativeWindow.show();
  }

  hide(): void {
    if (!this.nativeWindow.isDestroyed()) this.nativeWindow.hide();
  }

  focus(): void {
    if (!this.nativeWindow.isDestroyed()) this.nativeWindow.focus();
  }

  close(): void {
    if (!this.nativeWindow.isDestroyed()) this.nativeWindow.close();
  }

  destroy(): void {
    if (!this.nativeWindow.isDestroyed()) this.nativeWindow.destroy();
  }

  minimize(): void {
    if (!this.nativeWindow.isDestroyed()) this.nativeWindow.minimize();
  }

  toggleMaximize(): void {
    if (this.nativeWindow.isDestroyed()) return;
    if (this.nativeWindow.isMaximized()) this.nativeWindow.unmaximize();
    else this.nativeWindow.maximize();
  }

  isMaximized(): boolean {
    return !this.nativeWindow.isDestroyed() && this.nativeWindow.isMaximized();
  }

  load(url: string): Promise<void> {
    return this.nativeWindow.loadURL(url).then(() => undefined);
  }

  on(
    event: 'closed' | 'maximized' | 'unmaximized',
    listener: () => void,
  ): Unsubscribe {
    if (event === 'closed') {
      this.nativeWindow.on('closed', listener);
      return () => this.nativeWindow.removeListener('closed', listener);
    }
    if (event === 'maximized') {
      this.nativeWindow.on('maximize', listener);
      return () => this.nativeWindow.removeListener('maximize', listener);
    }
    this.nativeWindow.on('unmaximize', listener);
    return () => this.nativeWindow.removeListener('unmaximize', listener);
  }
}

function notificationOptions(
  options: DesktopNotificationOptions,
): NotificationConstructorOptions {
  return {
    title: options.title,
    body: options.body,
    ...(options.iconPath ? { icon: options.iconPath } : {}),
  };
}

function messageBoxOptions(options: DesktopDialogOptions): MessageBoxOptions {
  const result: MessageBoxOptions = {
    title: options.title,
    message: options.message,
  };
  if (options.type !== undefined) result.type = options.type;
  if (options.detail !== undefined) result.detail = options.detail;
  if (options.buttons !== undefined) result.buttons = [...options.buttons];
  if (options.defaultId !== undefined) result.defaultId = options.defaultId;
  if (options.cancelId !== undefined) result.cancelId = options.cancelId;
  if (options.noLink !== undefined) result.noLink = options.noLink;
  if (options.checkboxLabel !== undefined) result.checkboxLabel = options.checkboxLabel;
  if (options.checkboxChecked !== undefined) result.checkboxChecked = options.checkboxChecked;
  return result;
}

/**
 * Electron implementation used by the fallback shell and by unit tests that
 * inject a fake dependency set.
 */
export class ElectronDesktopPlatform implements DesktopPlatform {
  readonly shell: DesktopShell = 'electron';
  readonly os: DesktopOs = process.platform === 'win32' ? 'windows' : 'linux';

  private readonly deps: ElectronPlatformDependencies;
  private readonly windowDefaults: BrowserWindowConstructorOptions;
  private readonly windows = new Map<string, ElectronDesktopWindow>();

  constructor(options: ElectronDesktopPlatformOptions = {}) {
    this.deps = {
      ...defaultDependencies,
      ...options.dependencies,
    };
    this.windowDefaults = options.windowDefaults ?? {};
  }

  async createWindow(spec: DesktopWindowSpec): Promise<DesktopWindow> {
    const nativeWindow = new this.deps.BrowserWindow(
      windowOptionsForSpec(spec, this.windowDefaults),
    );
    const id = String(nativeWindow.id);
    const wrapped = new ElectronDesktopWindow(nativeWindow, spec.role, () => {
      this.windows.delete(id);
    });
    this.windows.set(id, wrapped);
    if (spec.url) await wrapped.load(spec.url);
    return wrapped;
  }

  getWindow(id: string): DesktopWindow | null {
    const existing = this.windows.get(id);
    if (existing && !existing.nativeWindow.isDestroyed()) return existing;
    if (existing) this.windows.delete(id);
    return null;
  }

  async openExternal(url: string): Promise<void> {
    await this.deps.shell.openExternal(url);
  }

  async openPath(path: string): Promise<void> {
    const error = await this.deps.shell.openPath(path);
    if (error) throw new Error(error);
  }

  async showItemInFolder(path: string): Promise<void> {
    this.deps.shell.showItemInFolder(path);
  }

  async writeClipboard(text: string): Promise<void> {
    this.deps.clipboard.writeText(text);
  }

  async showDialog(options: DesktopDialogOptions): Promise<DesktopDialogResult> {
    let parent: BrowserWindow | null = null;
    if (options.parentWindowId) {
      const wrapped = this.windows.get(options.parentWindowId);
      const fromId = this.deps.BrowserWindow.fromId;
      parent =
        wrapped?.nativeWindow ??
        (typeof fromId === 'function' ? fromId(Number(options.parentWindowId)) : null);
      if (parent?.isDestroyed()) parent = null;
    }
    const result = parent
      ? await this.deps.dialog.showMessageBox(
          parent,
          messageBoxOptions(options),
        )
      : await this.deps.dialog.showMessageBox(messageBoxOptions(options));
    return {
      response: result.response,
      ...(result.checkboxChecked === undefined
        ? {}
        : { checkboxChecked: result.checkboxChecked }),
    };
  }

  async showNotification(options: DesktopNotificationOptions): Promise<void> {
    const notification = new this.deps.Notification(notificationOptions(options));
    if (options.onClick) notification.on('click', options.onClick);
    notification.show();
  }

  registerShortcut(shortcut: DesktopShortcut): Unsubscribe {
    const registered = this.deps.globalShortcut.register(
      shortcut.accelerator,
      shortcut.handler,
    );
    if (!registered) {
      throw new Error(`failed to register shortcut: ${shortcut.accelerator}`);
    }
    return () => this.deps.globalShortcut.unregister(shortcut.accelerator);
  }
}

export function createElectronDesktopPlatform(
  options: ElectronDesktopPlatformOptions = {},
): ElectronDesktopPlatform {
  return new ElectronDesktopPlatform(options);
}
