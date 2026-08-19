/** bundle-integrity.d.ts — legacy `bundle-integrity.js` 垫片。迁 TS 后删除。 */

/** 损坏包条目。 */
export interface DamagedEntry {
  name: string;
  reason: string;
}

/** 校验结果。 */
export interface VerifyResult {
  ok: boolean;
  skipped: boolean;
  damaged: DamagedEntry[];
}

/** 构建时生成清单（after-pack 用；boot 只消费 verifyBundle）。 */
export declare function buildBundleManifest(nmRoot: string): unknown;
/** 按清单校验捆绑 node_modules 完整性（Issue #7）。 */
export declare function verifyBundle(nmRoot: string, manifest: unknown): VerifyResult;
