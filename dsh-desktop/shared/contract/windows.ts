/** Shared window labels and creation requests for Electron and Tauri shells. */

export type DesktopWindowKind =
  | 'main'
  | 'float'
  | 'wizard'
  | 'update'
  | 'recovery'
  | 'about';

export interface DesktopWindowOpenRequest {
  readonly kind: DesktopWindowKind;
  readonly sessionId?: string;
  readonly mode?: 'first' | 'rerun';
}

export interface DesktopWindowDescriptor {
  readonly kind: DesktopWindowKind;
  readonly label: string;
  readonly sessionId?: string;
  readonly visible: boolean;
}
