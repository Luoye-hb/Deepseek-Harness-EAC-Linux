/**
 * koffi-preflight.d.ts — legacy `koffi-preflight.js` 最小垫片。迁 TS 后删除。
 */

/** 预检依赖注入（spawn/spawnSync 由调用方提供，便于测试）。 */
export interface PreflightOpts {
  spawnSync?: unknown;
  spawn?: unknown;
  nodeExe: string;
  script: string;
  log(msg: string): void;
}

/** 同步 FFI 冒烟探针（卡事件循环，仅非 boot 链使用）。 */
export declare function runKoffiPreflight(opts: PreflightOpts): boolean;
/** 异步探针（boot 链使用；语义与同步版一致）。 */
export declare function runKoffiPreflightAsync(
  opts: PreflightOpts,
): Promise<boolean>;
/** 失败时写目录选择器 browse 降级 overlay，返回 overlay 路径。 */
export declare function enablePickerBrowseOverlay(opts: {
  file: string;
  log(msg: string): void;
}): string | null;
/** 探针恢复健康时清掉降级 overlay。 */
export declare function clearAutoPickerBrowseOverlay(opts: {
  file: string;
  log(msg: string): void;
}): void;
