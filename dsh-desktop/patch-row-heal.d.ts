/** patch-row-heal.d.ts — legacy `patch-row-heal.js` 垫片。迁 TS 后删除。 */
export declare function configLinesFor(config: Record<string, unknown>): string;
export interface HealResult {
  patch: string;
  healed: string[];
}
export declare function healSoulMdPatchRow(patch: string): HealResult;
export declare function healRowConfig(
  patch: string, id: string, defaults: Record<string, unknown>,
): HealResult;
export declare function removeBundledRowDuplicates(
  patch: string, rowIds: Record<string, string>,
  bundled: string[], declaredBundleIds: Set<string>,
): { patch: string; removed: string[] };
export declare function collectBundleEntryIds(
  bundled: string[], nodeModules: string,
): Set<string>;
