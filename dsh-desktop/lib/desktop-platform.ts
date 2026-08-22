/**
 * Process-wide platform adapter for the Electron fallback.
 *
 * Shared/core modules can import this boundary during the migration. The
 * future Tauri host will replace the composition root without changing those
 * modules' contracts.
 */

import type { MessageBoxOptions } from 'electron';
import { ElectronDesktopPlatform } from '../platform/electron-fallback/index.js';
import type {
  DesktopDialogOptions,
  DesktopDialogResult,
  DesktopNotificationOptions,
  DesktopPlatform,
} from '../shared/contract/desktop-platform.js';

export const desktopPlatform: DesktopPlatform = new ElectronDesktopPlatform();

export function toDesktopDialogOptions(
  options: MessageBoxOptions,
  parentWindowId?: string,
): DesktopDialogOptions {
  return {
    ...(options.type === undefined ? {} : { type: options.type }),
    title: options.title ?? '',
    message: options.message,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.buttons === undefined ? {} : { buttons: options.buttons }),
    ...(options.defaultId === undefined ? {} : { defaultId: options.defaultId }),
    ...(options.cancelId === undefined ? {} : { cancelId: options.cancelId }),
    ...(options.noLink === undefined ? {} : { noLink: options.noLink }),
    ...(options.checkboxLabel === undefined ? {} : { checkboxLabel: options.checkboxLabel }),
    ...(options.checkboxChecked === undefined ? {} : { checkboxChecked: options.checkboxChecked }),
    ...(parentWindowId === undefined ? {} : { parentWindowId }),
  };
}

export function fromDesktopDialogResult(
  result: DesktopDialogResult,
): { response: number; checkboxChecked?: boolean } {
  return {
    response: result.response,
    ...(result.checkboxChecked === undefined
      ? {}
      : { checkboxChecked: result.checkboxChecked }),
  };
}

export async function showDesktopDialog(
  options: MessageBoxOptions,
  parentWindowId?: string,
): Promise<{ response: number; checkboxChecked?: boolean }> {
  const result = await desktopPlatform.showDialog(
    toDesktopDialogOptions(options, parentWindowId),
  );
  return fromDesktopDialogResult(result);
}

export function showDesktopNotification(
  options: DesktopNotificationOptions,
): Promise<void> {
  return desktopPlatform.showNotification(options);
}
