/** Shared contract for the native recovery-center window. */

export type RecoveryCenterAction =
  | 'disable'
  | 'enable'
  | 'remove'
  | 'quarantine'
  | 'unquarantine'
  | 'snapshot'
  | 'rollback-last-good'
  | 'read-log';

export interface RecoveryCenterActionParams {
  readonly action: RecoveryCenterAction;
  readonly value?: unknown;
}

export interface RecoveryCenterReadLogParams {
  readonly action: 'read-log';
  readonly value?: unknown;
}

export interface RecoveryCenterState {
  readonly ok: boolean;
  readonly appVersion: string;
  readonly profile: string;
  readonly plugins: readonly unknown[];
  readonly snapshots: readonly unknown[];
  readonly incidents: readonly unknown[];
  readonly fence: {
    readonly mode: string;
    readonly limitation: string;
  };
}
