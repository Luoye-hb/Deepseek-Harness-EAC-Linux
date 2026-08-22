/**
 * Shared structured errors for the desktop-host and shell boundaries.
 *
 * This file is type-only so it can be imported by Electron, Tauri, the
 * desktop-host, and tests without creating a runtime dependency on a shell.
 */

/** Stable error envelope used across the desktop-host boundary. */
export interface DesktopError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

/** Error codes that already have a defined recovery meaning. */
export type DesktopErrorCode =
  | 'bad-request'
  | 'forbidden'
  | 'not-ready'
  | 'not-found'
  | 'timeout'
  | 'protocol-error'
  | 'frame-too-large'
  | 'duplicate-request'
  | 'host-exited'
  | 'unsupported'
  | (string & {});
