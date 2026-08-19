/** plugin-updater.d.ts — legacy `plugin-updater.js` 垫片。迁 TS 后删除。 */
export declare function versionOfDir(dir: string): string | null;
/** 24h 节流判定（settings.pluginUpdateCheckedAt）。 */
export declare function dueForCheck(ctx: unknown, now: number): boolean;
/** 记录本次检查时间。 */
export declare function markChecked(ctx: unknown): void;
/** settings.pluginAutoUpdate === true。 */
export declare function isAutoUpdateEnabled(ctx: unknown): boolean;
/** 逐源检查更新（npm registry / GitHub releases）。 */
export declare function checkPluginUpdates(
  ctx: unknown, sources: unknown[], opts: { force: boolean; profileDirP: string },
): Promise<unknown[]>;
/** 自动下载到覆盖层并复制进 profile。 */
export declare function autoApplyUpdates(
  ctx: unknown, sources: unknown[], opts: {
    profileDirP: string;
    guard: unknown;
    copyIntoProfile(overlayDir: string, name: string): void;
  },
): Promise<{ done: { name: string }[]; failed: { name: string }[] }>;
/** 手动更新单个内置插件（设置页「插件 → 更新」）。 */
export declare function applyBuiltinPluginUpdate(
  ctx: unknown, source: unknown, opts: {
    profileDirP: string;
    guard: unknown;
    copyIntoProfile(overlayDir: string, name: string): void;
  },
): Promise<{
  ok: boolean;
  noop?: boolean;
  current?: string;
  latest: string;
  restartRequired?: boolean;
  error?: string;
}>;
