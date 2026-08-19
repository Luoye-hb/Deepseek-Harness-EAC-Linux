/**
 * plugin-guard.d.ts — legacy `plugin-guard.js`（插件保护中心）最小垫片。
 * 迁 TS（Task 6）后删除；完整方法面见 plugin-guard.js 的 createGuard。
 */

/** 快照元数据。 */
export interface SnapshotMeta {
  id: string;
  reason: string;
  at: string;
  files: string[];
  pluginRows: string[];
}

/** 健康检查报告。 */
export interface HealthReport {
  findings: { code: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** createGuard 的依赖注入。 */
export interface GuardOpts {
  getHome(): string;
  getProfile(): string;
  dshBin(): string;
  log(tag: string, msg: string): void;
}

/** 插件保护中心实例（方法按调用面声明，未用到的略）。 */
export interface GuardInstance {
  snapshot(reason: string): SnapshotMeta | null;
  restore(id: unknown): unknown;
  lastGoodSnapshot(): SnapshotMeta | null;
  repairJunctions(): { repaired: string[] };
  junctionFindings(): unknown[];
  healthCheck(): HealthReport;
  repair(): { applied: string[] };
  listSnapshots(): SnapshotMeta[];
  listIncidents(): unknown[];
  readIncident(id: unknown): unknown;
  resolveIncident(id: unknown): unknown;
  markGood(id: string): void;
  setRollbackLift(fn: () => Promise<unknown>): void;
  guardedBoot(
    boot: () => Promise<string>,
    logHint: () => string,
    opts?: { preRetry?: (errText: string) => Promise<{ applied: string[] } | false> },
  ): Promise<string>;
  attributeBootFailure(errText: string): { name: string; rowId: string; kind: string } | null;
  [key: string]: unknown;
}

export declare function createGuard(opts: GuardOpts): GuardInstance;
export declare const GUARD_FILES: string[];
