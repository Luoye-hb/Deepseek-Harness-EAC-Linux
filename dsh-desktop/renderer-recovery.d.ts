/**
 * renderer-recovery.d.ts — legacy `renderer-recovery.js` 的最小类型垫片
 * （lib/window.ts 消费）。迁 TS（Task 7）后删除。
 */

/** 恢复状态机对宿主的依赖注入（lib/window.ts 的 initRendererRecovery 组装）。 */
export interface RendererRecoveryOpts {
  log(msg: string): void;
  isQuitting(): boolean;
  isServerAlive(): boolean;
  getTarget(): { kind: 'url'; url: string } | null;
  loadingPage: string;
  recoveryPage: string;
  rebuildMainWindow(opts?: { startHidden?: boolean }): unknown;
  waitServerUp(maxMs: number): Promise<string>;
  onGaveUp(lastFailure: string): void;
  onStable(): void;
  notify(title: string, body: string): void;
}

/** 单个窗口的恢复状态（gaveUp = 已放弃自动恢复，停在恢复页）。 */
export interface RecoveryState {
  gaveUp?: boolean;
  [key: string]: unknown;
}

export declare class RendererRecovery {
  constructor(opts: RendererRecoveryOpts);
  attach(win: unknown, kind: string): unknown;
  stateOf(win: unknown): RecoveryState | null;
  retryNow(win: unknown): unknown;
  noteHeartbeat(webContentsId: number): void;
  checkHeartbeats(): void;
}
