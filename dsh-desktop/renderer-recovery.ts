/**
 * renderer-recovery.ts — 渲染进程崩溃/挂起自恢复状态机（Issue #9 根治修复
 * 核心模块）（Task 7.1 自 renderer-recovery.js 迁 TS）。
 *
 * 背景：renderer 以 0xC0000005（ACCESS_VIOLATION）等异常退出后，旧实现只在
 * 三处 render-process-gone 处理器里记录日志、没有任何恢复动作，窗口永久
 * 黑屏/白屏，用户只能强制退出。本模块为「主窗 + 会话浮窗」提供统一自恢复：
 *
 *   · render-process-gone（crashed / killed / oom / …）→ 指数退避重新加载
 *   · 连续失败第 3 次 → 主窗销毁重建 BrowserWindow；浮窗直接关闭
 *   · 失败超过上限 → 主窗切到本地错误页（重载/重启/看日志按钮）+ 系统通知；
 *     绝不允许无限崩溃循环
 *   · unresponsive / 心跳丢失（AppHangB1 挂起）→ 宽限期后强制终结 renderer，
 *     复用同一条恢复路径
 *   · did-fail-load（连接失败等）→ 服务进程健在时退避重试（覆盖插件市场
 *     重启服务的间隙）；服务进程已退出时不动作，交给既有
 *     「DSH 服务已停止」对话框接管，避免双弹窗
 *   · 只有页面加载成功后「稳定存活 30 秒」才清零故障计数 —— 防止
 *     「加载即崩溃」的场景每次加载成功都重置计数造成无限快速循环
 *   · clean-exit / 退出中 / 窗口已销毁 一律不触发恢复
 *
 * 设计约束：本模块不 require('electron')，全部副作用经注入回调完成，
 * 状态机决策函数纯函数化导出，便于 node:test 单元测试与
 * DSH_DESKTOP_TEST 集成测试直接验证。
 */

import { pathToFileURL } from 'node:url';

/** 恢复策略参数（测试可注入覆盖）。 */
export interface RecoveryOpts {
  /** 一个「故障窗口」内允许的自动恢复动作总数（含重建主窗）。 */
  MAX_ATTEMPTS: number;
  /** 故障窗口时长：超过此时长无新故障（或已稳定）才清零计数。 */
  ATTEMPT_WINDOW_MS: number;
  /** 加载成功后需要稳定存活这么久才清零故障计数。 */
  STABILITY_MS: number;
  FIRST_DELAY_MS: number;
  BACKOFF_BASE_MS: number;
  BACKOFF_MAX_MS: number;
  LOAD_TIMEOUT_MS: number;
  UNRESPONSIVE_GRACE_MS: number;
  HEARTBEAT_MISS_MS: number;
  SERVER_WAIT_MAX_MS: number;
  ERROR_PAGE_RELOAD_MIN_INTERVAL_MS: number;
  HANG_PENDING_TOLERANCE_MS: number;
}

export const DEFAULT_OPTS: RecoveryOpts = {
  MAX_ATTEMPTS: 4,
  ATTEMPT_WINDOW_MS: 90 * 1000,
  STABILITY_MS: 30 * 1000,
  FIRST_DELAY_MS: 800,
  BACKOFF_BASE_MS: 2000,
  BACKOFF_MAX_MS: 15000,
  LOAD_TIMEOUT_MS: 30 * 1000,
  UNRESPONSIVE_GRACE_MS: 20 * 1000,
  HEARTBEAT_MISS_MS: 45 * 1000,
  SERVER_WAIT_MAX_MS: 60 * 1000,
  ERROR_PAGE_RELOAD_MIN_INTERVAL_MS: 10 * 1000,
  HANG_PENDING_TOLERANCE_MS: 10 * 1000,
};

/** 窗口类型：主窗 / 会话浮窗。 */
export type WindowKind = 'main' | 'float';

/** 恢复动作档位。 */
export type RecoveryAction = 'reload' | 'rebuild' | 'give-up';

/** 加载目标页。 */
export type LoadTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string } | null;

/** 单次故障记录（错误页 / 状态查询展示）。 */
export interface FailureRecord {
  reason: string;
  exitCode: number | null;
  at: string;
}

/** 窗口的最小结构类型（不依赖 electron）。 */
export interface RecoveryWindow {
  readonly id: number;
  isDestroyed(): boolean;
  destroy(): void;
  on(ev: 'show', cb: () => void): unknown;
  on(ev: 'hide', cb: () => void): unknown;
  readonly webContents: {
    readonly id: number;
    on(ev: string, cb: (...args: unknown[]) => void): unknown;
    getURL(): string;
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    forcefullyCrashRenderer?(): void;
  };
}

/** RendererRecovery 的注入依赖（全部由 lib/window.ts 提供）。 */
export interface RendererRecoveryDeps extends Partial<RecoveryOpts> {
  log(msg: string): void;
  isQuitting(): boolean;
  isServerAlive(): boolean;
  getTarget(win: RecoveryWindow): LoadTarget;
  loadingPage: string;
  recoveryPage: string;
  rebuildMainWindow(opts: { startHidden: boolean }): RecoveryWindow | null;
  waitServerUp(maxMs: number): Promise<unknown>;
  onGaveUp?(lastFailure: FailureRecord | null): void;
  onRecovered?(): void;
  onStable?(): void;
  notify?(title: string, body: string): void;
}

/** 单窗口恢复状态。 */
interface WindowState {
  kind: WindowKind;
  failures: number;
  windowStart: number;
  gaveUp: boolean;
  expectingWeb: boolean;
  userHidden: boolean; // 窗口创建时是隐藏的；show 事件后置 false
  attemptTimer: NodeJS.Timeout | null;
  stabilityTimer: NodeJS.Timeout | null;
  hangGrace: NodeJS.Timeout | null;
  hangDetectedAt: number;
  gen: number;
  rebuiltInBurst: boolean;
  failuresAtLoad: number;
  loadFlight: { active: boolean } | null; // 在途加载：active 时 did-fail-load 由加载调用方处理
  lastFailure: FailureRecord | null;
  lastErrorPageAt: number;
  pendingHangCrash: number;
}

/** 纯函数：按故障次数计算退避延迟（指数退避 + 抖动，避免雷击效应）。 */
export function computeBackoff(failureCount: number, opts?: Partial<RecoveryOpts>): number {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  if (failureCount <= 1) return o.FIRST_DELAY_MS;
  const cap = Math.min(o.BACKOFF_MAX_MS, o.BACKOFF_BASE_MS * 2 ** (failureCount - 1));
  const jitter = Math.round(cap * (0.15 + 0.2 * Math.random())); // +15%~+35%
  return Math.round(cap + jitter);
}

/** 纯函数：由当前故障计数决定下一步动作。
 *  failures 1~2 → reload；3（主窗且本窗口未重建过）→ rebuild；>MAX → give-up。 */
export function nextAction(failures: number, kind: WindowKind, rebuiltInBurst: boolean): RecoveryAction {
  if (failures > DEFAULT_OPTS.MAX_ATTEMPTS) return 'give-up';
  if (kind === 'main' && failures === 3 && !rebuiltInBurst) return 'rebuild';
  return 'reload';
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export class RendererRecovery {
  private opts: RendererRecoveryDeps & RecoveryOpts;
  private _states = new Map<number, WindowState>(); // winId -> state
  private _wins = new Set<RecoveryWindow>();
  private _heartbeats = new Map<number, number>(); // webContentsId -> lastBeatAt

  constructor(deps: RendererRecoveryDeps) {
    this.opts = { ...DEFAULT_OPTS, ...deps } as RendererRecoveryDeps & RecoveryOpts;
  }

  // ---------------------------------------------------------------- helpers

  private _log(msg: string): void {
    try {
      this.opts.log(msg);
    } catch {
      /* 日志失败不影响恢复 */
    }
  }

  private _state(win: RecoveryWindow): WindowState {
    let s = this._states.get(win.id);
    if (!s) {
      s = {
        kind: 'main',
        failures: 0,
        windowStart: 0,
        gaveUp: false,
        expectingWeb: false,
        userHidden: true,
        attemptTimer: null,
        stabilityTimer: null,
        hangGrace: null,
        hangDetectedAt: 0,
        gen: 0,
        rebuiltInBurst: false,
        failuresAtLoad: 0,
        loadFlight: null,
        lastFailure: null,
        lastErrorPageAt: 0,
        pendingHangCrash: 0,
      };
      this._states.set(win.id, s);
    }
    return s;
  }

  private _clearTimers(s: WindowState): void {
    if (s.attemptTimer) {
      clearTimeout(s.attemptTimer);
      s.attemptTimer = null;
    }
    if (s.stabilityTimer) {
      clearTimeout(s.stabilityTimer);
      s.stabilityTimer = null;
    }
    if (s.hangGrace) {
      clearTimeout(s.hangGrace);
      s.hangGrace = null;
    }
  }

  private _resetBurst(s: WindowState): void {
    this._clearTimers(s);
    s.failures = 0;
    s.failuresAtLoad = 0;
    s.windowStart = 0;
    s.gaveUp = false;
    s.rebuiltInBurst = false;
    s.lastFailure = null;
    s.pendingHangCrash = 0;
    s.hangDetectedAt = 0;
  }

  private _countFailure(_win: RecoveryWindow, s: WindowState): void {
    const now = Date.now();
    if (s.windowStart && now - s.windowStart > this.opts.ATTEMPT_WINDOW_MS) {
      // 故障窗口已过：这是一轮新的故障序列。
      s.windowStart = now;
      s.failures = 0;
      s.rebuiltInBurst = false;
    }
    if (!s.windowStart) s.windowStart = now;
    s.failures += 1;
  }

  private _sameTargetUrl(url: string, target: LoadTarget): boolean {
    if (!target || !url) return false;
    if (target.kind === 'url') return sameOrigin(url, target.url);
    if (target.kind === 'file') {
      try {
        return url === pathToFileURL(target.path).href;
      } catch {
        return false;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- 对外 API

  /** 把恢复机制挂到窗口上（主窗/浮窗）。重复 attach 同窗口只追加一次状态。 */
  attach(win: RecoveryWindow, kind: WindowKind): void {
    if (!win || win.isDestroyed()) return;
    const s = this._state(win);
    s.kind = kind;
    const wc = win.webContents;

    wc.on('render-process-gone', (...args: unknown[]) => this._onGone(win, args[1] as { reason?: string; exitCode?: number } | undefined));
    wc.on('unresponsive', () => this._onUnresponsive(win));
    wc.on('responsive', () => this._onResponsive(win));
    wc.on('did-finish-load', () => this._onFinishLoad(win));
    wc.on('did-fail-load', (...args: unknown[]) => {
      // (_e, code, desc, url, isMainFrame)
      const code = args[1] as number | undefined;
      const desc = args[2] as string | undefined;
      const url = args[3] as string | undefined;
      const isMainFrame = args[4] as boolean | undefined;
      if (isMainFrame) this._onFailLoad(win, { code: code ?? 0, desc: desc ?? '', url: url ?? '' });
    });
    wc.on('destroyed', () => {
      this._states.delete(win.id);
      this._heartbeats.delete(wc.id);
      this._wins.delete(win);
    });
    // 可见性用 show/hide 事件自行追踪（而非 isVisible()）：后者在挂起、
    // RDP/服务会话等场景下会误报 false，导致挂起判定被永远跳过。
    win.on('show', () => {
      const st = this._state(win);
      st.userHidden = false;
      // 窗口重新可见：给 renderer 一段宽限恢复心跳（后台节流会让心跳
      // 时间戳陈旧），避免「从托盘唤出」瞬间被误判为挂起。
      this._heartbeats.set(wc.id, Date.now());
    });
    win.on('hide', () => {
      this._state(win).userHidden = true;
    });

    this._wins.add(win);
  }

  /** preload 每 5s 上报一次心跳。 */
  noteHeartbeat(wcId: number): void {
    this._heartbeats.set(wcId, Date.now());
  }

  /** 由 window.ts 的定时器周期调用；只对「可见（未被用户隐藏）且应显示
   *  Web UI」的窗口判定。可见性来自 show/hide 事件追踪。 */
  checkHeartbeats(): void {
    const now = Date.now();
    for (const win of this._wins) {
      if (!win || win.isDestroyed()) continue;
      const s = this._state(win);
      if (!s.expectingWeb || s.gaveUp || s.hangGrace) continue;
      if (s.userHidden) continue;
      const last = this._heartbeats.get(win.webContents.id) || 0;
      if (last && now - last > this.opts.HEARTBEAT_MISS_MS) {
        this._log(`心跳丢失 ${now - last}ms（kind=${s.kind}），视为挂起进入恢复`);
        this._onUnresponsive(win);
      }
    }
  }

  /** 错误页「重新加载」按钮：清零状态并立即重新加载目标页。 */
  retryNow(win: RecoveryWindow): boolean {
    if (!win || win.isDestroyed()) return false;
    const s = this._state(win);
    this._resetBurst(s);
    s.gen += 1;
    this._log(`用户请求立即恢复加载（kind=${s.kind}）`);
    this._schedule(win, s);
    return true;
  }

  /** 错误页展示用状态。 */
  stateOf(win: RecoveryWindow): {
    kind: WindowKind;
    failures: number;
    gaveUp: boolean;
    expectingWeb: boolean;
    lastFailure: FailureRecord | null;
  } | null {
    if (!win || win.isDestroyed()) return null;
    const s = this._state(win);
    return {
      kind: s.kind,
      failures: s.failures,
      gaveUp: s.gaveUp,
      expectingWeb: s.expectingWeb,
      lastFailure: s.lastFailure,
    };
  }

  dispose(): void {
    for (const s of this._states.values()) this._clearTimers(s);
    this._states.clear();
    this._wins.clear();
    this._heartbeats.clear();
  }

  // ---------------------------------------------------------------- 事件入口

  private _onGone(win: RecoveryWindow, details: { reason?: string; exitCode?: number } | undefined): void {
    if (this.opts.isQuitting() || win.isDestroyed()) return;
    const s = this._state(win);
    const reason = details && details.reason;
    if (reason === 'clean-exit') {
      // 主动销毁/退出产生的正常退出：只复位计时器，不触发恢复。
      this._clearTimers(s);
      return;
    }
    const now = Date.now();
    if (s.pendingHangCrash && now - s.pendingHangCrash < this.opts.HANG_PENDING_TOLERANCE_MS) {
      // 挂起流程已经计数并准备恢复，这里不重复计数。
      s.pendingHangCrash = 0;
    } else {
      this._countFailure(win, s);
    }
    s.lastFailure = {
      reason: String(reason || 'unknown'),
      exitCode: details && details.exitCode !== undefined ? Number(details.exitCode) : null,
      at: new Date().toISOString(),
    };
    // 使在途的恢复加载尝试失效：其后续完成/失败结果不再被信任，
    // 避免「崩溃事件已计数、旧尝试失败路径又计数一次」的重复计数。
    s.gen += 1;
    this._log(
      `渲染进程异常退出: reason=${s.lastFailure.reason} exitCode=${s.lastFailure.exitCode} ` +
        `kind=${s.kind} failures=${s.failures}${s.gaveUp ? ' (已放弃自动恢复)' : ''}`,
    );
    if (s.gaveUp) {
      // 错误页自身崩溃：限频地重新加载错误页；浮窗直接关闭。
      if (s.kind === 'main') this._showErrorPage(win, s);
      else this._closeFloat(win);
      return;
    }
    this._schedule(win, s);
  }

  private _onUnresponsive(win: RecoveryWindow): void {
    if (this.opts.isQuitting() || win.isDestroyed()) return;
    const s = this._state(win);
    if (s.gaveUp || !s.expectingWeb || s.hangGrace) return;
    this._log(`检测到界面无响应（kind=${s.kind}），宽限 ${this.opts.UNRESPONSIVE_GRACE_MS}ms 后强制恢复`);
    s.hangDetectedAt = Date.now();
    s.hangGrace = setTimeout(() => {
      s.hangGrace = null;
      if (win.isDestroyed() || this.opts.isQuitting() || s.gaveUp) return;
      // 宽限期到：若「挂起判定之后」收到过心跳说明 renderer 已恢复，
      // 取消处理；否则强制终结 renderer 触发恢复路径。
      const last = this._heartbeats.get(win.webContents.id) || 0;
      if (last && last > s.hangDetectedAt) {
        this._log('宽限期内心跳恢复，取消挂起处理');
        return;
      }
      this._log('界面持续无响应，强制终结渲染进程以触发恢复');
      s.pendingHangCrash = Date.now();
      s.lastFailure = { reason: 'unresponsive', exitCode: null, at: new Date().toISOString() };
      this._countFailure(win, s);
      let forced = false;
      try {
        if (typeof win.webContents.forcefullyCrashRenderer === 'function') {
          win.webContents.forcefullyCrashRenderer(); // 后续由 render-process-gone 统一走恢复
          forced = true;
        }
      } catch (err) {
        this._log('强制终结渲染进程失败: ' + String((err as Error).message));
      }
      if (!forced) this._schedule(win, s);
    }, this.opts.UNRESPONSIVE_GRACE_MS);
    if (s.hangGrace && typeof s.hangGrace.unref === 'function') s.hangGrace.unref();
  }

  private _onResponsive(win: RecoveryWindow): void {
    const s = this._state(win);
    if (s.hangGrace) {
      clearTimeout(s.hangGrace);
      s.hangGrace = null;
      this._log('界面已恢复响应，取消挂起处理');
    }
  }

  private _onFinishLoad(win: RecoveryWindow): void {
    if (win.isDestroyed()) return;
    const s = this._state(win);
    const target = this.opts.getTarget(win);
    const url = win.webContents.getURL();
    if (target && target.kind === 'url' && this._sameTargetUrl(url, target)) {
      if (s.gaveUp) {
        // 放弃后由旧尝试加载成功的 Web UI 不算恢复：强制切回错误页，
        // 防止「放弃 → 旧尝试加载成功 → 清零 → 再崩溃」的撤销循环。
        this._log('已放弃自动恢复，忽略迟到的 Web 加载，回到恢复页');
        this._showErrorPage(win, s, true);
        return;
      }
      // Web UI 加载成功：进入「心跳监控」；记录加载时刻的故障计数，
      // 稳定期结束时若期间又发生新故障则保留计数（脏检查），
      // 防止「崩溃→恢复→崩溃」的慢速循环因每次都清零而无限延续。
      s.expectingWeb = true;
      s.failuresAtLoad = s.failures;
      this._log(`界面加载成功: ${url}`);
      if (s.stabilityTimer) clearTimeout(s.stabilityTimer);
      s.stabilityTimer = setTimeout(() => {
        s.stabilityTimer = null;
        if (win.isDestroyed()) return;
        if (s.failures === (s.failuresAtLoad || 0)) {
          // 本轮加载后没有新故障：完全康复，清零计数并上报健康状态。
          this._log(`界面已稳定（failures=${s.failures}），清零故障计数`);
          try {
            this.opts.onStable && this.opts.onStable();
          } catch {
            /* 回调异常不影响恢复 */
          }
          this._resetBurst(s);
        } else {
          this._log(`界面已稳定，但故障窗口内又发生故障（failures=${s.failures}），保留计数防止循环`);
        }
        s.expectingWeb = true;
      }, this.opts.STABILITY_MS);
      if (s.stabilityTimer && typeof s.stabilityTimer.unref === 'function') s.stabilityTimer.unref();
    } else if (target && target.kind === 'file' && this._sameTargetUrl(url, target)) {
      // 加载页/错误页加载完成：非 Web 内容，心跳监控不启用。
      s.expectingWeb = false;
    }
  }

  private _onFailLoad(win: RecoveryWindow, info: { code: number; desc: string; url: string }): void {
    if (this.opts.isQuitting() || win.isDestroyed()) return;
    if (info.code === -3) return; // ERR_ABORTED：重载/跳转的正常中断
    const s = this._state(win);
    if (s.gaveUp) return; // 错误页自身的加载失败无须处理
    if (s.loadFlight && s.loadFlight.active) {
      // 属于恢复模块自己的在途加载：由 _attempt 的 Promise 结果统一处理，
      // 这里不重复计数/调度。
      return;
    }
    const target = this.opts.getTarget(win);
    if (!this._sameTargetUrl(info.url, target)) return; // 只关心目标页主框架
    this._log(`目标页加载失败: code=${info.code} desc=${info.desc || ''} url=${info.url}`);
    if (!this.opts.isServerAlive()) {
      // 服务进程已退出：既有「DSH 服务已停止」对话框接管交互；
      // 浮窗留在原地是死屏，直接关闭。
      this._log('服务进程已退出，交由既有重启对话框处理');
      if (s.kind === 'float') this._closeFloat(win);
      return;
    }
    this._countFailure(win, s);
    this._schedule(win, s);
  }

  // ---------------------------------------------------------------- 恢复流程

  private _schedule(win: RecoveryWindow, s: WindowState): void {
    if (s.attemptTimer) {
      // 新故障到来时取消排队中的恢复动作，按最新计数重新决策：
      // 否则单飞机制会让「重建 / 放弃」分级被快速故障潮跳过
      // （例如计数从 2 直接跳到 6，重建档永远轮不到）。
      clearTimeout(s.attemptTimer);
      s.attemptTimer = null;
      s.gen += 1; // 同时放弃可能在途的加载尝试，其结果不再被信任
    }
    const action = nextAction(s.failures, s.kind, s.rebuiltInBurst);
    if (action === 'give-up') {
      this._giveUp(win, s);
      return;
    }
    if (action === 'rebuild') {
      this._rebuildNow(win, s);
      return;
    }
    const delay = computeBackoff(s.failures, this.opts);
    this._log(`安排恢复: kind=${s.kind} failures=${s.failures} 延迟=${delay}ms 动作=reload`);
    s.attemptTimer = setTimeout(() => {
      s.attemptTimer = null;
      s.gen += 1;
      void this._attempt(win, s, s.gen);
    }, delay);
    if (s.attemptTimer && typeof s.attemptTimer.unref === 'function') s.attemptTimer.unref();
  }

  private async _attempt(win: RecoveryWindow, s: WindowState, gen: number): Promise<void> {
    if (this.opts.isQuitting() || win.isDestroyed() || gen !== s.gen) return;
    let target = this.opts.getTarget(win);
    if (!target) {
      // 尚未拿到 webUrl（启动早期崩溃）：主窗回加载页，boot 流程会继续接管；
      // 浮窗此时不存在，防御性关闭。
      if (s.kind === 'float') {
        this._closeFloat(win);
        return;
      }
      target = { kind: 'file', path: this.opts.loadingPage };
    }
    const tgt: NonNullable<LoadTarget> = target;
    try {
      await this._loadTracked(win, s, tgt, gen);
      return; // 成功：由 did-finish-load 进入稳定期判定
    } catch (err) {
      if (this.opts.isQuitting() || win.isDestroyed() || gen !== s.gen) return;
      if (/ERR_ABORTED/.test(String((err as Error)?.message || err))) {
        // 被更新的加载（用户 Ctrl+R / 新恢复动作）取代：不视为失败。
        return;
      }
      this._log(`恢复加载失败: ${String((err as Error)?.message || err)}`);
      // 1) 服务进程健在但连不上：多为插件市场原地重启的间隙，
      //    等待服务恢复后用「最新」webUrl 重试一次，不计入崩溃失败。
      if (tgt.kind === 'url' && this.opts.isServerAlive()) {
        let waited = false;
        try {
          await this.opts.waitServerUp(this.opts.SERVER_WAIT_MAX_MS);
          waited = true;
        } catch {
          waited = false;
        }
        if (this.opts.isQuitting() || win.isDestroyed() || gen !== s.gen) return;
        const fresh = this.opts.getTarget(win);
        if (waited && fresh && fresh.kind === 'url') {
          try {
            await this._loadTracked(win, s, fresh, gen);
            return;
          } catch (err2) {
            if (gen !== s.gen || /ERR_ABORTED/.test(String((err2 as Error)?.message || err2))) return;
            this._log(`服务恢复后重试加载仍失败: ${String((err2 as Error)?.message || err2)}`);
          }
        }
      }
      // 2) 服务进程已退出：既有对话框接管，不循环、不弹窗。
      if (tgt.kind === 'url' && !this.opts.isServerAlive()) {
        this._log('服务进程已退出，交由既有重启对话框处理');
        if (s.kind === 'float') this._closeFloat(win);
        return;
      }
      // 3) 常规失败：计入并进入下一档（重载 → 重建 → 放弃）。
      this._countFailure(win, s);
      this._schedule(win, s);
    }
  }

  /** 带「在途标记」的加载：did-fail-load 事件与该加载属于同一动作，
   *  由本函数的 Promise 结果统一处理，避免事件与拒绝路径重复计数。 */
  private async _loadTracked(win: RecoveryWindow, s: WindowState, target: NonNullable<LoadTarget>, gen: number): Promise<void> {
    const flight = { active: true };
    s.loadFlight = flight;
    try {
      await this._loadWithTimeout(win, target, gen);
    } finally {
      flight.active = false;
      if (s.loadFlight === flight) s.loadFlight = null;
    }
  }

  private _loadWithTimeout(win: RecoveryWindow, target: NonNullable<LoadTarget>, _gen: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (win.isDestroyed()) {
        reject(new Error('window destroyed'));
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      /** 一次性落定（成功/失败共用；先到者生效）。 */
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const ok = (): void => {
        if (settled) return;
        settle();
        resolve();
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settle();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const p = target.kind === 'url' ? win.webContents.loadURL(target.url) : win.webContents.loadFile(target.path);
      p.then(
        () => ok(),
        (err) => fail(err),
      );
      timer = setTimeout(() => {
        // 超时只放弃本次等待，绝不 kill webContents：慢加载（首次启动等）
        // 是合法场景；后续故障事件或下一次调度会继续处理。
        fail(new Error('load timeout'));
      }, this.opts.LOAD_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  private _rebuildNow(win: RecoveryWindow, s: WindowState): void {
    this._log(`连续失败达到重建阈值（failures=${s.failures}），重建主窗口`);
    const carried: Partial<WindowState> = {
      failures: s.failures,
      windowStart: s.windowStart,
      rebuiltInBurst: true,
      lastFailure: s.lastFailure,
    };
    let newWin: RecoveryWindow | null = null;
    try {
      newWin = this.opts.rebuildMainWindow({ startHidden: s.userHidden });
    } catch (err) {
      this._log(`重建主窗口异常: ${String((err as Error)?.message || err)}`);
      this._countFailure(win, s);
      this._schedule(win, s);
      return;
    }
    if (!newWin || newWin.isDestroyed()) {
      this._countFailure(win, s);
      this._schedule(win, s);
      return;
    }
    const ns = this._state(newWin);
    Object.assign(ns, carried);
    this._log('主窗口已重建，继续恢复流程');
    this._schedule(newWin, ns);
  }

  private _giveUp(win: RecoveryWindow, s: WindowState): void {
    if (s.gaveUp) return;
    s.gaveUp = true;
    this._clearTimers(s);
    s.gen += 1; // 使所有在途的恢复尝试失效，其结果不再被信任
    this._log(`自动恢复失败达到上限，kind=${s.kind} failures=${s.failures}，停止自动恢复`);
    if (s.kind === 'main') {
      this._showErrorPage(win, s, true);
      try {
        this.opts.onGaveUp && this.opts.onGaveUp(s.lastFailure);
      } catch {
        /* 回调异常不影响恢复 */
      }
      try {
        this.opts.notify &&
          this.opts.notify(
            'DSH Desktop 界面多次异常退出',
            '已暂停自动恢复并显示恢复页面。你的数据与后台任务不受影响，仍在继续运行。',
          );
      } catch {
        /* 通知失败静默 */
      }
    } else {
      this._closeFloat(win);
    }
  }

  private _showErrorPage(win: RecoveryWindow, s: WindowState, force = false): void {
    if (win.isDestroyed()) return;
    const now = Date.now();
    if (!force && now - s.lastErrorPageAt < this.opts.ERROR_PAGE_RELOAD_MIN_INTERVAL_MS) return;
    s.lastErrorPageAt = now;
    this._log('加载本地恢复页面');
    if (this.opts.recoveryPage) {
      win.webContents.loadFile(this.opts.recoveryPage).catch(() => {});
    }
  }

  private _closeFloat(win: RecoveryWindow): void {
    this._log('关闭无法恢复的浮窗');
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* destroy 失败静默 */
    }
  }
}
