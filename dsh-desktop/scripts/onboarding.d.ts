/** scripts/onboarding.d.ts — legacy 垫片。迁 TS 后删除。 */
export declare const CORE_PLUGIN_IDS: Set<string>;
export declare const RECOMMENDED_PLUGIN_IDS: Set<string>;
export declare function buildCatalog(
  companion: unknown[], opts: Record<string, unknown>,
): unknown;
export declare function pluginCurrentState(
  entries: unknown[], companion: unknown[],
): unknown;
