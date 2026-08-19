/**
 * balance.d.ts — legacy `balance.js`（DeepSeek 余额/峰谷定价）最小垫片。
 * 迁 TS 后删除。
 */

/** 单档价格（输入/输出百万 tokens 计价）。 */
export interface TierPrice {
  input: number;
  output: number;
  [key: string]: unknown;
}

/** 峰谷定价状态（period 指当前命中档位）。 */
export interface PricingState {
  period: 'peak' | 'offpeak';
  nextChangeIso?: string;
  windows?: unknown[];
  [key: string]: unknown;
}

/** queryBalance 结果（prices/pricing 由 lib/balance-ui 加工后回填）。 */
export interface BalanceResult {
  ok: boolean;
  error?: string;
  balances: unknown[];
  prices?: Record<string, TierPrice>;
  pricing?: PricingState & { prices?: { peak: TierPrice; offpeak: TierPrice } };
}

export declare function queryBalance(dshHome: string): Promise<BalanceResult>;
/** 校验/清洗用户自定义价格（三字段非负数字，非法抛错）。 */
export declare function sanitizePrices(prices: unknown): {
  cacheMiss: number;
  cacheHit: number;
  output: number;
};
export declare function readActiveModel(dshHome: string): string | null;
export declare const DEFAULT_PRICES: Record<string, TierPrice>;
export declare const FALLBACK_PRICES: TierPrice;
export declare function computePricingState(
  peakWindows?: unknown,
): PricingState;
export declare function tierPrices(
  base: TierPrice, override: Record<string, unknown>, src: 'peak' | 'offpeak',
): TierPrice;
