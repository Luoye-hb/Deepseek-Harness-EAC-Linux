/** builtin-collision.d.ts — legacy `builtin-collision.js` 垫片。迁 TS 后删除。 */
export interface MigrateResult {
  changed: boolean;
  ok: boolean;
  removedDep: string[];
  removedRows: string[];
}
export declare function removeMarketDuplicate(
  profileDir: string, name: string, opts: { log: (m: string) => void },
): MigrateResult;
export declare function patchHasForeignRows(patchText: string, name: string): boolean;
