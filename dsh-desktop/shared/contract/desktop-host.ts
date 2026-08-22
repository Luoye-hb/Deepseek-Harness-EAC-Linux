/**
 * Shared desktop-host RPC contract.
 *
 * Transport details are deliberately kept out of this file. Electron and
 * Tauri adapters may use the same length-prefixed stdio transport while the
 * business layer only sees these messages.
 */

import type { DesktopError } from './errors.js';
import type {
  UpdateApplyParams,
  UpdateCancelParams,
  UpdateCheckParams,
  UpdateJobResult,
  UpdateSnapshot,
} from './update.js';

/** Current protocol version. Breaking changes require a new version. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 1;

/** Maximum encoded frame size required by the migration plan. */
export const DESKTOP_HOST_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Default timeout for ordinary requests. Long work uses events instead. */
export const DESKTOP_HOST_DEFAULT_TIMEOUT_MS = 15_000;

export interface DesktopHostRequest {
  readonly kind: 'req';
  readonly version: number;
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

export interface DesktopHostResponse {
  readonly kind: 'res';
  readonly version: number;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: DesktopError;
}

export interface DesktopHostEvent {
  readonly kind: 'notify';
  readonly version: number;
  readonly event: string;
  readonly payload: unknown;
}

/** Best-effort cancellation of an in-flight request. */
export interface DesktopHostCancel {
  readonly kind: 'cancel';
  readonly version: number;
  readonly id: string;
}

export type DesktopHostMessage =
  | DesktopHostRequest
  | DesktopHostResponse
  | DesktopHostEvent
  | DesktopHostCancel;

export interface DesktopHostPingResult {
  readonly pid: number;
  readonly node: string;
  readonly now: number;
}

export interface DshStartParams {
  readonly nodePath: string;
  readonly npmCliPath?: string;
  readonly dshBin: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly port?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly extraArgs?: readonly string[];
  readonly bootTimeoutMs?: number;
  readonly httpTimeoutMs?: number;
  readonly logPath?: string;
  readonly useSystemCa?: boolean;
  readonly assetsDir?: string;
}

export interface DshStartResult {
  readonly ok: true;
  readonly url: string;
  readonly pid?: number;
  readonly reused?: boolean;
}

export interface DshStopResult {
  readonly ok: true;
  readonly stopped: boolean;
}

export interface DshStatusResult {
  readonly running: boolean;
  readonly url?: string;
  readonly pid?: number;
}

export interface DesktopHostMethodMap {
  'host:ping': {
    params: null;
    result: DesktopHostPingResult;
  };
  'host:status': {
    params: null;
    result: DshStatusResult;
  };
  'host:shutdown': {
    params: null;
    result: { readonly ok: true };
  };
  'dsh:start': {
    params: DshStartParams;
    result: DshStartResult;
  };
  'dsh:stop': {
    params: null;
    result: DshStopResult;
  };
  'recovery:reload': {
    params: null;
    result: DshStartResult;
  };
  'balance:refresh': {
    params: null;
    result: unknown;
  };
  'balance:prices:get': {
    params: { readonly model?: unknown };
    result: unknown;
  };
  'balance:prices:set': {
    params: { readonly model?: unknown; readonly prices?: unknown };
    result: unknown;
  };
  'balance:prices:reset': {
    params: { readonly model?: unknown };
    result: unknown;
  };
  'plugin:list': {
    params: null;
    result: unknown;
  };
  'plugin:set-enabled': {
    params: { readonly id?: unknown; readonly enabled?: unknown };
    result: unknown;
  };
  'plugin:set-removed': {
    params: { readonly id?: unknown; readonly removed?: unknown };
    result: unknown;
  };
  'image-paste:save': {
    params: { readonly dataUrl?: unknown; readonly name?: unknown };
    result: unknown;
  };
  'plugin:updates': {
    params: { readonly force?: unknown };
    result: unknown;
  };
  'plugin:update': {
    params: { readonly id?: unknown };
    result: unknown;
  };
  'plugin:auto-update': {
    params: { readonly enabled?: unknown };
    result: unknown;
  };
  'guard:action': {
    params: { readonly action?: unknown; readonly value?: unknown };
    result: unknown;
  };
  'recovery:state': {
    params: null;
    result: unknown;
  };
  'recovery:export-logs': {
    params: null;
    result: unknown;
  };
  'recovery:action': {
    params: { readonly action?: unknown; readonly value?: unknown };
    result: unknown;
  };
  'diagnostic:page-error': {
    params: { readonly message?: unknown };
    result: { readonly ok: true };
  };
  'onboard:needs': {
    params: null;
    result: { readonly needed: boolean };
  };
  'onboard:list': {
    params: { readonly mode?: unknown };
    result: unknown;
  };
  'onboard:submit': {
    params: { readonly mode?: unknown; readonly ids?: unknown };
    result: unknown;
  };
  'onboard:close': {
    params: { readonly mode?: unknown };
    result: { readonly ok: true; readonly cancelled: true };
  };
  'menu:state': {
    params: null;
    result: unknown;
  };
  'menu:action': {
    params: { readonly action?: unknown; readonly value?: unknown };
    result: unknown;
  };
  'file:revert': {
    params: { readonly changes?: unknown };
    result: unknown;
  };
  'file:validate-open': {
    params: { readonly path?: unknown };
    result: unknown;
  };
  'update:state': {
    params: UpdateCheckParams;
    result: UpdateSnapshot;
  };
  'update:check': {
    params: UpdateCheckParams;
    result: UpdateSnapshot;
  };
  'update:apply': {
    params: UpdateApplyParams;
    result: UpdateJobResult;
  };
  'update:cancel': {
    params: UpdateCancelParams;
    result: UpdateJobResult;
  };
}
