/** Shared contract for the native update window and desktop-host jobs. */

export type UpdateKind = 'agent' | 'client';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'unsupported'
  | 'starting'
  | 'running'
  | 'ready'
  | 'cancelled'
  | 'failed';

export interface UpdateCheckParams {
  readonly kind: UpdateKind;
}

export interface UpdateApplyParams {
  readonly kind: UpdateKind;
  readonly version?: string;
}

export interface UpdateCancelParams {
  readonly jobId: string;
}

export interface UpdateProgress {
  readonly stage: string;
  readonly count?: number;
  readonly elapsed?: string;
  readonly registry?: string | null;
  readonly received?: number;
  readonly total?: number;
  readonly speedMBps?: number;
  readonly etaSec?: number;
}

export interface UpdateSnapshot {
  readonly kind: UpdateKind;
  readonly state: UpdateState;
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly source?: string;
  readonly jobId?: string;
  readonly message?: string;
  readonly progress?: UpdateProgress;
  readonly release?: unknown;
}

export interface UpdateJobResult {
  readonly ok: boolean;
  readonly jobId?: string;
  readonly error?: string;
}
