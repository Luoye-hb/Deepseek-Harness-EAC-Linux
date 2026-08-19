/** scripts/plugin-manager-patch.d.ts — legacy 垫片。迁 TS 后删除。 */
export declare function togglePluginInPatch(
  text: string, id: string, enabled: boolean, name: string,
): string;
export declare function removePluginFromPatch(text: string, id: string): string;
export declare function hasEntryId(patch: string, id: string): boolean;
