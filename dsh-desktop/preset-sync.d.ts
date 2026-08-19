/** preset-sync.d.ts — legacy `preset-sync.js` 垫片。迁 TS 后删除。 */
export interface PresetSyncResult {
  installed: string[];
}
export declare function syncBundledPresets(
  src: string, dest: string, log: (m: string) => void,
): PresetSyncResult;
export declare function ensureDefaultAgentPreset(
  home: string, preset: string, log: (m: string) => void,
): 'set' | 'kept' | string;
