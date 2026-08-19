/** scripts/onboarding.d.ts — legacy 垫片。迁 TS 后删除。 */
export declare const CORE_PLUGIN_IDS: Set<string>;
export declare const RECOMMENDED_PLUGIN_IDS: Set<string>;
/** 全新 vs 老用户判定（在任何写盘之前调用）。 */
export declare function needsPluginOnboarding(opts: {
  settings: Record<string, unknown>;
  settingsFileExists: boolean;
  profileDirExists: boolean;
  sharedProfileExists: boolean;
}): boolean;
export declare function buildCatalog(
  companion: unknown[], opts: Record<string, unknown>,
): unknown;
export declare function pluginCurrentState(
  entries: unknown[], companion: unknown[],
): unknown;
