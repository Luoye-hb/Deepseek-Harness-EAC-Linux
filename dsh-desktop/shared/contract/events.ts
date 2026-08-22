/**
 * Typed event names shared by Electron and the future Tauri bridge.
 *
 * Existing Electron channel names remain in use during migration. These names
 * are the shell-neutral contract that adapters will translate to and from.
 */

export interface DesktopMaximizeChangedEvent {
  readonly isMaximized: boolean;
}

export interface DesktopBalanceChangedEvent {
  readonly data: unknown;
}

export interface DesktopRecoveryStateChangedEvent {
  readonly state: unknown;
}

export interface DesktopServiceStateChangedEvent {
  readonly state: unknown;
}

export interface DesktopFilesDroppedEvent {
  readonly files: readonly {
    readonly path: string;
    readonly name?: string;
    readonly size?: number;
  }[];
}

export interface DesktopEventMap {
  'window.maximized': DesktopMaximizeChangedEvent;
  'balance.changed': DesktopBalanceChangedEvent;
  'recovery.state': DesktopRecoveryStateChangedEvent;
  'service.state': DesktopServiceStateChangedEvent;
  'files.drop': DesktopFilesDroppedEvent;
}

export type DesktopEventName = keyof DesktopEventMap;

export interface DesktopEvent<Name extends DesktopEventName = DesktopEventName> {
  readonly event: Name;
  readonly payload: DesktopEventMap[Name];
}

export type DesktopEventListener<Name extends DesktopEventName> = (
  payload: DesktopEventMap[Name],
) => void;
