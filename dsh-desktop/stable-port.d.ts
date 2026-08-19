/**
 * stable-port.d.ts — legacy `stable-port.js` 的最小类型垫片（lib/server.ts 消费）。
 * 待 stable-port.js 迁 TS 后删除。
 */

/** stable-port 模块的依赖注入上下文（main.js 侧的 stablePortCtx 桥接 updater）。 */
export interface StablePortCtx {
  loadSettings(): Record<string, unknown>;
  saveSettings(ctx: unknown, settings: Record<string, unknown>): void;
}

/**
 * 返回 URL 端口号所属的 Chromium 受限端口；不受限返回 0。
 * （参数是完整 URL 或 host:port 字符串。）
 */
export declare function restrictedPortOf(url: string): number;

/** 选择稳定 Web 端口（复用 settings.webPort，避开受限端口）。 */
export declare function chooseStableWebPort(ctx: StablePortCtx): Promise<number>;
