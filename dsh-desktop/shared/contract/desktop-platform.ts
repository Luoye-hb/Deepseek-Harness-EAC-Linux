/**
 * Native capability boundary for shared desktop business code.
 *
 * Implementations may use Electron during migration and Tauri/Rust later.
 * Shared services must depend on this interface rather than importing either
 * shell directly.
 */

import type { DesktopShell, Unsubscribe } from './desktop-api.js';

export type DesktopOs = 'windows' | 'linux';

export type DesktopWindowRole =
  | 'main'
  | 'float'
  | 'wizard'
  | 'update'
  | 'recovery'
  | 'about';

export interface DesktopWindowSpec {
  readonly role: DesktopWindowRole;
  readonly url?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  readonly resizable?: boolean;
  readonly frameless?: boolean;
}

export interface DesktopWindow {
  readonly id: string;
  readonly role: DesktopWindowRole;
  show(): void;
  hide(): void;
  focus(): void;
  close(): void;
  destroy(): void;
  minimize(): void;
  toggleMaximize(): void;
  isMaximized(): boolean;
  load(url: string): Promise<void>;
  on(event: 'closed' | 'maximized' | 'unmaximized', listener: () => void): Unsubscribe;
}

export interface DesktopDialogOptions {
  readonly type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
  readonly buttons?: readonly string[];
  readonly defaultId?: number;
  readonly cancelId?: number;
  readonly noLink?: boolean;
  readonly checkboxLabel?: string;
  readonly checkboxChecked?: boolean;
  /** Parent window id, if the shell supports modal ownership. */
  readonly parentWindowId?: string;
}

export interface DesktopDialogResult {
  readonly response: number;
  readonly checkboxChecked?: boolean;
}

export interface DesktopNotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly iconPath?: string;
  readonly onClick?: () => void;
}

export interface DesktopShortcut {
  readonly accelerator: string;
  readonly handler: () => void;
}

export interface DesktopPlatform {
  readonly shell: DesktopShell;
  readonly os: DesktopOs;
  createWindow(spec: DesktopWindowSpec): Promise<DesktopWindow>;
  getWindow(id: string): DesktopWindow | null;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  showDialog(options: DesktopDialogOptions): Promise<DesktopDialogResult>;
  showNotification(options: DesktopNotificationOptions): Promise<void>;
  registerShortcut(shortcut: DesktopShortcut): Unsubscribe;
}
