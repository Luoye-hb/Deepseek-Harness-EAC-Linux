/**
 * Shell-neutral desktop business services.
 *
 * This module owns business operations that are shared by the Electron
 * fallback and the Tauri desktop-host. It accepts runtime paths and logging as
 * dependencies so it never needs Electron or Tauri state.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as balance from '../../balance.js';
import * as structuredLogger from '../../logger.js';
import * as updater from '../../updater.js';
import type { BalanceResult, PriceEntry, TierPrice } from '../../balance.js';
import type { UpdCtx } from '../../updater.js';

export interface DesktopBusinessRuntime {
  readonly userDataDir: string;
  readonly dshHome: string;
  readonly appVersion?: string;
  readonly nodePath?: string;
  readonly npmCliPath?: string;
  readonly assetsDir?: string;
  readonly logsDir?: string;
}

export interface DesktopBusinessServiceOptions {
  readonly runtime?: Partial<DesktopBusinessRuntime>;
  readonly notify?: (event: string, payload: unknown) => void;
  readonly log?: (tag: string, message: string) => void;
}

export interface BalancePricesGetParams {
  readonly model?: unknown;
}

export interface BalancePricesSetParams {
  readonly model?: unknown;
  readonly prices?: unknown;
}

export interface BalancePricesResetParams {
  readonly model?: unknown;
}

export interface DesktopMenuState {
  readonly notifyOnTurnEnd: boolean;
  readonly closeToTray: boolean;
  readonly exitAction: 'ask' | 'minimize' | 'quit';
  readonly shortcutPolicy: 'auto' | 'never';
}

function defaultRuntime(): DesktopBusinessRuntime {
  return {
    userDataDir:
      process.env.DSH_DESKTOP_USERDATA?.trim() ||
      path.join(os.homedir(), '.deepseek-harness-eac'),
    dshHome: process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'),
    nodePath: process.execPath,
  };
}

export function createDesktopUpdaterContext(
  runtime: DesktopBusinessRuntime,
  log: (tag: string, message: string) => void,
): UpdCtx {
  return {
    userDataDir: runtime.userDataDir,
    nodeExe: () => runtime.nodePath ?? process.execPath,
    npmCli: () =>
      runtime.npmCliPath ??
      path.join(path.dirname(runtime.nodePath ?? process.execPath), 'npm-cli.js'),
    log,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Business operations used by both shells.
 *
 * The service is intentionally state-light. The host owns the process and
 * emits the returned data as events; the Electron adapter can continue to
 * update its renderer cache in its own composition layer.
 */
export class DesktopBusinessService {
  private runtime: DesktopBusinessRuntime;
  private readonly notify: (event: string, payload: unknown) => void;
  private readonly writeLog: (tag: string, message: string) => void;

  constructor(options: DesktopBusinessServiceOptions = {}) {
    this.runtime = { ...defaultRuntime(), ...options.runtime };
    this.notify = options.notify ?? (() => {});
    this.writeLog = options.log ?? (() => {});
  }

  configure(runtime: Partial<DesktopBusinessRuntime>): void {
    this.runtime = { ...this.runtime, ...runtime };
  }

  async refreshBalance(): Promise<BalanceResult> {
    const ctx = this.updaterContext();
    let result: BalanceResult;
    try {
      result = await balance.queryBalance(this.runtime.dshHome);
    } catch (error) {
      result = {
        ok: false,
        error: String((error as Error).message || error),
        balances: [],
        prices: {},
      };
    }

    const model = balance.readActiveModel(this.runtime.dshHome) || 'deepseek-v4-pro';
    const table: Record<string, PriceEntry> =
      result.prices ?? balance.DEFAULT_PRICES;
    const settings = updater.loadSettings(ctx);
    const pricing = balance.computePricingState(
      (settings.pricing as { peakWindows?: unknown } | undefined)?.peakWindows,
    );
    const base: PriceEntry = table[model] ?? balance.FALLBACK_PRICES;
    const overrides =
      (settings.balancePrices as Record<string, unknown> | undefined)?.[model] ?? {};
    const tier = (period: 'peak' | 'offpeak'): TierPrice =>
      balance.tierPrices(base, overrides, period);

    result.prices = { [model]: tier(pricing.period) };
    result.pricing = {
      ...pricing,
      prices: { peak: tier('peak'), offpeak: tier('offpeak') },
    };
    this.notify('balance.changed', { data: result });
    return result;
  }

  getBalancePrices(params: unknown): {
    ok: true;
    model: string;
    defaults: balance.DualPrice;
    current: unknown;
  } {
    const model = String(asRecord(params).model ?? '');
    const settings = updater.loadSettings(this.updaterContext());
    const defaults =
      balance.DEFAULT_PRICES[model] ?? balance.FALLBACK_PRICES;
    const prices = settings.balancePrices as Record<string, unknown> | undefined;
    const current = prices?.[model] ?? null;
    return { ok: true, model, defaults, current };
  }

  async setBalancePrices(params: unknown): Promise<{ ok: boolean; error?: string }> {
    const input = asRecord(params);
    const model = String(input.model ?? '');
    if (!balance.DEFAULT_PRICES[model]) {
      return { ok: false, error: '未知模型: ' + model };
    }
    try {
      const cleaned = balance.sanitizePrices(input.prices as {
        peak?: unknown;
        offpeak?: unknown;
      });
      const ctx = this.updaterContext();
      const settings = updater.loadSettings(ctx);
      if (!settings.balancePrices || typeof settings.balancePrices !== 'object') {
        settings.balancePrices = {};
      }
      (settings.balancePrices as Record<string, unknown>)[model] = cleaned;
      updater.saveSettings(ctx, settings);
      await this.refreshBalance();
      return { ok: true };
    } catch (error) {
      this.writeLog('balance', '保存余额价格失败: ' + String((error as Error).message || error));
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  async resetBalancePrices(params: unknown): Promise<{ ok: boolean; error?: string }> {
    const model = String(asRecord(params).model ?? '');
    try {
      const ctx = this.updaterContext();
      const settings = updater.loadSettings(ctx);
      const prices = settings.balancePrices as Record<string, unknown> | undefined;
      if (prices?.[model] !== undefined) {
        delete prices[model];
        updater.saveSettings(ctx, settings);
      }
      await this.refreshBalance();
      return { ok: true };
    } catch (error) {
      this.writeLog('balance', '重置余额价格失败: ' + String((error as Error).message || error));
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  async exportDiagnostics(): Promise<{ ok: boolean; zipPath?: string; error?: string }> {
    try {
      const zipPath = await structuredLogger.buildDiagnosticsZip({
        logsDir: this.runtime.logsDir ?? path.join(this.runtime.userDataDir, 'logs'),
        userDataDir: this.runtime.userDataDir,
        dshHome: this.runtime.dshHome,
      });
      return { ok: true, zipPath };
    } catch (error) {
      this.writeLog(
        'recovery',
        '导出诊断日志失败: ' + String((error as Error).message || error),
      );
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  menuState(): DesktopMenuState {
    const settings = updater.loadSettings(this.updaterContext());
    const closeToTray = settings.closeToTray !== false;
    const exitAction =
      settings.exitAction === 'ask' ||
      settings.exitAction === 'minimize' ||
      settings.exitAction === 'quit'
        ? settings.exitAction
        : settings.closeToTray === false
          ? 'quit'
          : settings.closeToTray === true
            ? 'minimize'
            : 'ask';
    return {
      notifyOnTurnEnd: settings.notifyOnTurnEnd !== false,
      closeToTray,
      exitAction,
      shortcutPolicy: settings.shortcutPolicy === 'never' ? 'never' : 'auto',
    };
  }

  menuAction(action: string, value?: unknown): DesktopMenuState {
    const settings = updater.loadSettings(this.updaterContext());
    switch (action) {
      case 'toggle-notify':
        settings.notifyOnTurnEnd = !this.menuState().notifyOnTurnEnd;
        break;
      case 'toggle-close-to-tray':
        settings.closeToTray = !this.menuState().closeToTray;
        break;
      case 'set-exit-action':
        if (value === 'ask' || value === 'minimize' || value === 'quit') {
          settings.exitAction = value;
          settings.closeToTray = value !== 'quit';
        }
        break;
      case 'toggle-shortcut-policy':
        settings.shortcutPolicy =
          settings.shortcutPolicy === 'never' ? 'auto' : 'never';
        break;
      default:
        return this.menuState();
    }
    updater.saveSettings(this.updaterContext(), settings);
    return this.menuState();
  }

  logsDir(): string {
    return this.runtime.logsDir ?? path.join(this.runtime.userDataDir, 'logs');
  }

  private updaterContext(): UpdCtx {
    return createDesktopUpdaterContext(this.runtime, this.writeLog);
  }
}
