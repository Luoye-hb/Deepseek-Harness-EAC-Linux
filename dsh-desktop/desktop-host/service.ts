/**
 * desktop-host business assembly.
 *
 * The service owns the dsh web lifecycle and emits lifecycle notifications
 * through the RPC peer. It deliberately has no Electron/Tauri dependency.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
  DesktopHostPingResult,
  DshStartParams,
  DshStartResult,
  DshStatusResult,
  DshStopResult,
} from '../shared/contract/desktop-host.js';
import { startDshWeb, type DshWebHandle } from '../shared/desktop-core/dsh-web.js';
import { ensureProfileRuntimeClosure } from '../shared/desktop-core/profile-runtime.js';
import {
  DesktopBusinessService,
  type DesktopBusinessRuntime,
} from '../shared/business/desktop-business.js';
import { PluginBusinessService } from '../shared/business/plugin-business.js';
import { FileBusinessService } from '../shared/business/file-business.js';
import { OnboardingBusinessService } from '../shared/business/onboarding-business.js';
import { RecoveryBusinessService } from '../shared/business/recovery-business.js';
import { UpdateBusinessService } from '../shared/business/update-business.js';
import type { DesktopHostRpc } from './rpc.js';

export interface DesktopHostServiceOptions {
  readonly notify: (event: string, payload: unknown) => void;
  readonly now?: () => number;
  readonly runtime?: Partial<DesktopBusinessRuntime>;
}

function requireExistingPath(value: unknown, name: string): string {
  const result = String(value ?? '');
  if (!result || !fs.existsSync(result)) {
    throw new Error(`dsh:start requires existing ${name}`);
  }
  return result;
}

function parseStartParams(
  params: unknown,
): DshStartParams & { nodePath: string; dshBin: string } {
  const raw = (params ?? {}) as Record<string, unknown>;
  return {
    nodePath: requireExistingPath(raw.nodePath, 'nodePath'),
    ...(typeof raw.npmCliPath === 'string' ? { npmCliPath: raw.npmCliPath } : {}),
    dshBin: requireExistingPath(raw.dshBin, 'dshBin'),
    ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.host === 'string' ? { host: raw.host } : {}),
    ...(typeof raw.port === 'number' ? { port: raw.port } : {}),
    ...(typeof raw.env === 'object' && raw.env
      ? { env: raw.env as Readonly<Record<string, string | undefined>> }
      : {}),
    ...(Array.isArray(raw.extraArgs)
      ? { extraArgs: raw.extraArgs.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(typeof raw.bootTimeoutMs === 'number' ? { bootTimeoutMs: raw.bootTimeoutMs } : {}),
    ...(typeof raw.httpTimeoutMs === 'number' ? { httpTimeoutMs: raw.httpTimeoutMs } : {}),
    ...(typeof raw.logPath === 'string' ? { logPath: raw.logPath } : {}),
    ...(typeof raw.useSystemCa === 'boolean' ? { useSystemCa: raw.useSystemCa } : {}),
    ...(typeof raw.assetsDir === 'string' ? { assetsDir: raw.assetsDir } : {}),
  };
}

export class DesktopHostService {
  private dsh: DshWebHandle | null = null;
  private startPromise: Promise<DshStartResult> | null = null;
  private readonly intentionalStops = new Set<ChildProcess>();
  private readonly notify: (event: string, payload: unknown) => void;
  private readonly now: () => number;
  private readonly business: DesktopBusinessService;
  private readonly plugins: PluginBusinessService;
  private readonly files: FileBusinessService;
  private readonly onboarding: OnboardingBusinessService;
  private readonly recovery: RecoveryBusinessService;
  private readonly updates: UpdateBusinessService;
  private lastStartParams: (DshStartParams & { nodePath: string; dshBin: string }) | null = null;
  // First-run detection must happen before profile initialization or plugin sync.
  // Those operations create the very files used to distinguish a new user.
  private onboardingNeeded: boolean | null = null;

  constructor(options: DesktopHostServiceOptions) {
    this.notify = options.notify;
    this.now = options.now ?? Date.now;
    const runtime: DesktopBusinessRuntime = {
      userDataDir:
        options.runtime?.userDataDir ??
        process.env.DSH_DESKTOP_USERDATA?.trim() ??
        path.join(os.homedir(), '.deepseek-harness-eac'),
      dshHome:
        options.runtime?.dshHome ??
        process.env.DSH_HOME?.trim() ??
        path.join(os.homedir(), '.dsh'),
      ...(options.runtime?.appVersion === undefined ? {} : { appVersion: options.runtime.appVersion }),
      ...(options.runtime?.nodePath === undefined ? {} : { nodePath: options.runtime.nodePath }),
      ...(options.runtime?.npmCliPath === undefined ? {} : { npmCliPath: options.runtime.npmCliPath }),
      ...(options.runtime?.assetsDir === undefined ? {} : { assetsDir: options.runtime.assetsDir }),
      ...(options.runtime?.logsDir === undefined ? {} : { logsDir: options.runtime.logsDir }),
    };
    this.business = new DesktopBusinessService({
      runtime,
      notify: options.notify,
      log: (tag, message) => this.notify('log', { tag, message }),
    });
    this.plugins = new PluginBusinessService({
      runtime,
      log: (tag, message) => this.notify('log', { tag, message }),
    });
    this.files = new FileBusinessService({ runtime });
    this.onboarding = new OnboardingBusinessService({
      runtime,
      log: (tag, message) => this.notify('log', { tag, message }),
    });
    this.recovery = new RecoveryBusinessService({
      runtime,
      log: (tag, message) => this.notify('log', { tag, message }),
    });
    this.updates = new UpdateBusinessService({
      runtime,
      notify: options.notify,
      log: (tag, message) => this.notify('log', { tag, message }),
    });
  }

  register(peer: DesktopHostRpc): void {
    peer.handle('host:ping', () => this.ping());
    peer.handle('host:status', () => this.status());
    peer.handle('dsh:start', (params) => this.start(params));
    peer.handle('dsh:stop', () => this.stop());
    peer.handle('recovery:reload', () => this.reloadDsh());
    peer.handle('balance:refresh', () => this.business.refreshBalance());
    peer.handle('balance:prices:get', (params) => this.business.getBalancePrices(params));
    peer.handle('balance:prices:set', (params) => this.business.setBalancePrices(params));
    peer.handle('balance:prices:reset', (params) => this.business.resetBalancePrices(params));
    peer.handle('plugin:list', () => this.plugins.list());
    peer.handle('plugin:set-enabled', (params) => {
      const input = (params ?? {}) as { id?: unknown; enabled?: unknown };
      return this.plugins.setEnabled(String(input.id ?? ''), input.enabled === true);
    });
    peer.handle('plugin:set-removed', (params) => {
      const input = (params ?? {}) as { id?: unknown; removed?: unknown };
      return this.plugins.setRemoved(String(input.id ?? ''), input.removed === true);
    });
    peer.handle('plugin:updates', (params) => {
      const input = (params ?? {}) as { force?: unknown };
      return this.plugins.listUpdates(input.force === true);
    });
    peer.handle('plugin:update', (params) => {
      const input = (params ?? {}) as { id?: unknown };
      return this.plugins.update(String(input.id ?? ''));
    });
    peer.handle('plugin:auto-update', (params) => {
      const input = (params ?? {}) as { enabled?: unknown };
      return this.plugins.setAutoUpdate(input.enabled === true);
    });
    peer.handle('guard:action', (params) => {
      const input = (params ?? {}) as { action?: unknown; value?: unknown };
      return this.plugins.guardAction(
        String(input.action ?? ''),
        input.value,
        this.dsh !== null,
      );
    });
    peer.handle('recovery:state', () => ({
      appVersion: process.env.DSH_DESKTOP_VERSION ?? '0.0.0',
      logsDir: this.businessLogsDir(),
      state: {
        host: this.status(),
        dsh: this.dsh ? { running: true, url: this.dsh.url } : { running: false },
      },
    }));
    peer.handle('recovery:export-logs', () => this.business.exportDiagnostics());
    peer.handle('recovery:action', (params) => {
      const input = (params ?? {}) as { action?: unknown; value?: unknown };
      if (input.action === 'status') {
        return this.recovery.status(
          this.dsh !== null,
          process.env.DSH_DESKTOP_VERSION ?? '0.0.0',
        );
      }
      return this.recovery.action(input.action, input.value, this.dsh !== null);
    });
    peer.handle('diagnostic:page-error', (params) => {
      const input = (params ?? {}) as { message?: unknown };
      const message = String(input.message ?? '').slice(0, 4096);
      if (message) this.notify('log', { tag: 'page-error', message });
      return { ok: true as const };
    });
    peer.handle('onboard:needs', () => ({
      needed: this.onboardingNeeded ?? this.onboarding.needsOnboarding(),
    }));
    peer.handle('onboard:list', (params) => {
      const input = (params ?? {}) as { mode?: unknown };
      return this.onboarding.list(input.mode);
    });
    peer.handle('onboard:submit', (params) => {
      const input = (params ?? {}) as { mode?: unknown; ids?: unknown };
      const result = this.onboarding.submit(input.mode, input.ids);
      if (result.ok) this.onboardingNeeded = false;
      return result;
    });
    peer.handle('onboard:close', () => {
      const result = this.onboarding.cancel();
      this.onboardingNeeded = false;
      return result;
    });
    peer.handle('menu:state', () => this.business.menuState());
    peer.handle('menu:action', (params) => {
      const input = (params ?? {}) as { action?: unknown; value?: unknown };
      return this.business.menuAction(String(input.action ?? ''), input.value);
    });
    peer.handle('image-paste:save', (params) => {
      const input = (params ?? {}) as { dataUrl?: unknown; name?: unknown };
      return this.plugins.imagePasteSave(input.dataUrl, input.name);
    });
    peer.handle('file:revert', (params) => {
      const input = (params ?? {}) as { changes?: unknown };
      return this.files.revert(input.changes);
    });
    peer.handle('file:validate-open', (params) => {
      const input = (params ?? {}) as { path?: unknown };
      return this.files.validateOpen(input.path);
    });
    peer.handle('update:state', (params) => {
      const input = (params ?? {}) as { kind?: unknown };
      return this.updates.state(input.kind);
    });
    peer.handle('update:check', (params) => {
      const input = (params ?? {}) as { kind?: unknown };
      return this.updates.check(input.kind);
    });
    peer.handle('update:apply', (params) => {
      const input = (params ?? {}) as { kind?: unknown; version?: unknown };
      return this.updates.startApply(input.kind, input.version);
    });
    peer.handle('update:cancel', (params) => {
      const input = (params ?? {}) as { jobId?: unknown };
      return this.updates.cancel(input.jobId);
    });
  }

  ping(): DesktopHostPingResult {
    return {
      pid: process.pid,
      node: process.version,
      now: this.now(),
    };
  }

  status(): DshStatusResult {
    if (!this.dsh) return { running: false };
    return {
      running: true,
      url: this.dsh.url,
      ...(this.dsh.process.pid ? { pid: this.dsh.process.pid } : {}),
    };
  }

  async start(params: unknown): Promise<DshStartResult> {
    if (this.dsh) {
      return {
        ok: true,
        url: this.dsh.url,
        ...(this.dsh.process.pid === undefined ? {} : { pid: this.dsh.process.pid }),
        reused: true,
      };
    }
    if (this.startPromise) return this.startPromise;

    const options = parseStartParams(params);
    const configuredUserDataDir =
      options.env?.DSH_DESKTOP_USERDATA?.trim() ??
      process.env.DSH_DESKTOP_USERDATA?.trim();
    const runtime: Partial<DesktopBusinessRuntime> = {
      ...(configuredUserDataDir === undefined ? {} : { userDataDir: configuredUserDataDir }),
      ...(options.env?.DSH_HOME
        ? { dshHome: options.env.DSH_HOME }
        : process.env.DSH_HOME
          ? { dshHome: process.env.DSH_HOME }
          : {}),
      nodePath: options.nodePath,
      ...(options.npmCliPath === undefined ? {} : { npmCliPath: options.npmCliPath }),
      ...(options.assetsDir === undefined ? {} : { assetsDir: options.assetsDir }),
      ...(options.logPath === undefined ? {} : { logsDir: path.dirname(options.logPath) }),
    };
    this.business.configure(runtime);
    this.plugins.configure(runtime);
    this.files.configure(runtime);
    this.onboarding.configure(runtime);
    this.recovery.configure(runtime);
    this.updates.configure(runtime);
    if (this.onboardingNeeded === null) {
      this.onboardingNeeded = this.onboarding.needsOnboarding();
    }
    ensureProfileRuntimeClosure(
      runtime.dshHome ?? path.join(os.homedir(), '.dsh'),
      options.dshBin,
      (message) => this.notify('log', { tag: 'profile-runtime', message }),
    );
    this.plugins.syncCompanionPlugins();
    this.lastStartParams = options;
    this.notify('service.state', { state: 'starting' });
    const startPromise = this.startInternal(options);
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } catch (error) {
      this.notify('service.state', {
        state: 'failed',
        error: String((error as Error).message || error),
      });
      throw error;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  private businessLogsDir(): string {
    return this.business.logsDir();
  }

  async reloadDsh(): Promise<DshStartResult> {
    if (this.dsh) {
      return {
        ok: true,
        url: this.dsh.url,
        ...(this.dsh.process.pid === undefined ? {} : { pid: this.dsh.process.pid }),
        reused: true,
      };
    }
    if (!this.lastStartParams) {
      throw new Error('dsh has not been started yet');
    }
    return this.start(this.lastStartParams);
  }

  async stop(): Promise<DshStopResult> {
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }
    const current = this.dsh;
    if (!current) return { ok: true, stopped: false };
    this.dsh = null;
    this.notify('service.state', { state: 'stopping' });
    this.intentionalStops.add(current.process);
    await current.stop();
    this.notify('service.state', { state: 'stopped' });
    return { ok: true, stopped: true };
  }

  async shutdown(): Promise<{ readonly ok: true }> {
    await this.stop();
    return { ok: true };
  }

  private async startInternal(
    options: DshStartParams & { nodePath: string; dshBin: string },
  ): Promise<DshStartResult> {
    const handle = await startDshWeb({
      nodePath: options.nodePath,
      dshBin: options.dshBin,
      profile: options.profile ?? 'web-desktop',
      cwd: options.cwd ?? process.cwd(),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
      ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
      ...(options.httpTimeoutMs === undefined ? {} : { httpTimeoutMs: options.httpTimeoutMs }),
      ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
      ...(options.useSystemCa === undefined ? {} : { useSystemCa: options.useSystemCa }),
    });
    this.dsh = handle;
    handle.process.once('exit', (code, signal) => {
      const intentional = this.intentionalStops.delete(handle.process);
      if (this.dsh?.process === handle.process) this.dsh = null;
      this.notify('dsh.exit', {
        code,
        signal,
        intentional,
        url: handle.url,
      });
      this.notify('service.state', {
        state: intentional ? 'stopped' : 'failed',
        code,
        signal,
      });
    });
    this.notify('dsh.ready', { url: handle.url, pid: handle.process.pid ?? null });
    this.notify('service.state', { state: 'running', url: handle.url });
    return {
      ok: true,
      url: handle.url,
      ...(handle.process.pid === undefined ? {} : { pid: handle.process.pid }),
    };
  }
}
