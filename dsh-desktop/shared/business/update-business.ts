/** Shell-neutral update checks and long-running update jobs. */

import * as clientUpdater from '../../client-updater.js';
import * as updater from '../../updater.js';
import type {
  UpdateKind,
  UpdateJobResult,
  UpdateProgress,
  UpdateSnapshot,
  UpdateState,
} from '../contract/update.js';
import type { DesktopBusinessRuntime } from './desktop-business.js';
import { createDesktopUpdaterContext } from './desktop-business.js';
import { PluginBusinessService } from './plugin-business.js';

export interface UpdateBusinessOptions {
  readonly runtime: DesktopBusinessRuntime;
  readonly notify?: (event: string, payload: unknown) => void;
  readonly log?: (tag: string, message: string) => void;
}

function isKind(value: unknown): value is UpdateKind {
  return value === 'agent' || value === 'client';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

export class UpdateBusinessService {
  private runtime: DesktopBusinessRuntime;
  private readonly notify: (event: string, payload: unknown) => void;
  private readonly writeLog: (tag: string, message: string) => void;
  private readonly plugins: PluginBusinessService;
  private readonly snapshots = new Map<UpdateKind, UpdateSnapshot>();
  private readonly checks = new Map<UpdateKind, Promise<UpdateSnapshot>>();
  private readonly jobs = new Map<string, { kind: UpdateKind; cancelled: boolean }>();
  private nextJob = 0;

  constructor(options: UpdateBusinessOptions) {
    this.runtime = options.runtime;
    this.notify = options.notify ?? (() => {});
    this.writeLog = options.log ?? (() => {});
    this.plugins = new PluginBusinessService({
      runtime: this.runtime,
      log: this.writeLog,
    });
    for (const kind of ['agent', 'client'] as const) {
      this.snapshots.set(kind, {
        kind,
        state: 'idle',
        currentVersion: this.currentVersion(kind),
      });
    }
  }

  configure(runtime: Partial<DesktopBusinessRuntime>): void {
    this.runtime = { ...this.runtime, ...runtime };
    this.plugins.configure(runtime);
    for (const kind of ['agent', 'client'] as const) {
      const current = this.snapshots.get(kind);
      if (current && current.state === 'idle') {
        this.snapshots.set(kind, { ...current, currentVersion: this.currentVersion(kind) });
      }
    }
  }

  state(kindValue: unknown): UpdateSnapshot {
    const kind = this.requireKind(kindValue);
    return this.snapshots.get(kind) ?? {
      kind,
      state: 'idle',
      currentVersion: this.currentVersion(kind),
    };
  }

  async check(kindValue: unknown): Promise<UpdateSnapshot> {
    const kind = this.requireKind(kindValue);
    const existing = this.checks.get(kind);
    if (existing) return existing;
    const promise = this.checkInternal(kind).finally(() => {
      if (this.checks.get(kind) === promise) this.checks.delete(kind);
    });
    this.checks.set(kind, promise);
    return promise;
  }

  startApply(kindValue: unknown, versionValue?: unknown): UpdateJobResult {
    const kind = this.requireKind(kindValue);
    const current = this.state(kind);
    if (current.state === 'running' || current.state === 'starting') {
      return { ok: false, error: 'update-already-running', ...(current.jobId ? { jobId: current.jobId } : {}) };
    }
    if (kind === 'client') {
      return {
        ok: false,
        error: process.platform === 'win32'
          ? 'Tauri 客户端更新器尚未配置签名 manifest'
          : 'Linux 客户端更新由系统包管理器或 AppImage 更新路径负责',
      };
    }
    const version = String(versionValue ?? current.latestVersion ?? '').trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      return { ok: false, error: '没有可安装的有效 agent 版本' };
    }
    const jobId = `update-${++this.nextJob}`;
    this.jobs.set(jobId, { kind, cancelled: false });
    this.setSnapshot(kind, {
      ...current,
      state: 'starting',
      jobId,
      message: '正在准备更新',
    });
    void this.runAgentApply(jobId, version);
    return { ok: true, jobId };
  }

  cancel(jobIdValue: unknown): UpdateJobResult {
    const jobId = String(jobIdValue ?? '');
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: 'unknown-update-job' };
    job.cancelled = true;
    void updater.abort();
    this.setSnapshot(job.kind, {
      ...this.state(job.kind),
      state: 'cancelled',
      jobId,
      message: '更新已取消',
    });
    return { ok: true, jobId };
  }

  private async checkInternal(kind: UpdateKind): Promise<UpdateSnapshot> {
    const currentVersion = this.currentVersion(kind);
    this.setSnapshot(kind, { kind, state: 'checking', currentVersion });
    try {
      if (kind === 'agent') {
        const latestVersion = await updater.checkLatest(this.context());
        const state: UpdateState = updater.compareVersions(latestVersion, currentVersion) > 0
          ? 'available'
          : 'current';
        return this.setSnapshot(kind, {
          kind,
          state,
          currentVersion,
          latestVersion,
          message: state === 'available' ? '发现新的 agent 版本' : '当前 agent 已是最新版本',
        });
      }
      if (process.platform !== 'win32') {
        return this.setSnapshot(kind, {
          kind,
          state: 'unsupported',
          currentVersion,
          message: 'Linux 客户端更新由系统包管理器或 AppImage 更新路径负责',
        });
      }
      const release = await clientUpdater.checkLatest(this.clientContext(), currentVersion);
      return this.setSnapshot(kind, {
        kind,
        state: release.isNewer ? 'available' : 'current',
        currentVersion,
        latestVersion: release.version,
        source: release.source,
        release,
        message: release.isNewer ? '发现新的客户端版本' : '当前客户端已是最新版本',
      });
    } catch (error) {
      const message = errorMessage(error);
      this.writeLog('update', `${kind} update check failed: ${message}`);
      return this.setSnapshot(kind, {
        kind,
        state: 'failed',
        currentVersion,
        message,
      });
    }
  }

  private async runAgentApply(jobId: string, version: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const kind = job.kind;
    try {
      const snapshot = this.plugins.guardAction('snapshot', `pre-update:dsh:${version}`, true);
      if (isRecord(snapshot) && snapshot.ok === false) {
        throw new Error(String(snapshot.error ?? '更新前配置快照失败'));
      }
      this.setSnapshot(kind, {
        ...this.state(kind),
        state: 'running',
        jobId,
        latestVersion: version,
        message: '正在下载并安装 agent',
      });
      const result = await updater.applyUpdate(this.context(), version, {
        onProgress: (progress) => {
          const currentJob = this.jobs.get(jobId);
          if (!currentJob || currentJob.cancelled) return;
          this.setSnapshot(kind, {
            ...this.state(kind),
            state: 'running',
            jobId,
            progress: this.normalizeProgress(progress),
          });
        },
      });
      this.setSnapshot(kind, {
        ...this.state(kind),
        state: 'ready',
        jobId,
        latestVersion: result.version,
        message: '更新已安装，重启 Web 服务后生效',
      });
    } catch (error) {
      const message = errorMessage(error);
      this.writeLog('update', `${kind} update failed: ${message}`);
      const currentJob = this.jobs.get(jobId);
      this.setSnapshot(kind, {
        ...this.state(kind),
        state: currentJob?.cancelled ? 'cancelled' : 'failed',
        jobId,
        message: currentJob?.cancelled ? '更新已取消' : message,
      });
    } finally {
      this.jobs.delete(jobId);
    }
  }

  private normalizeProgress(progress: updater.AgentProgressEvent): UpdateProgress {
    return {
      stage: progress.stage,
      ...(progress.count === undefined ? {} : { count: progress.count }),
      ...(progress.elapsed === undefined ? {} : { elapsed: progress.elapsed }),
      ...(progress.registry === undefined ? {} : { registry: progress.registry }),
    };
  }

  private setSnapshot(kind: UpdateKind, snapshot: UpdateSnapshot): UpdateSnapshot {
    this.snapshots.set(kind, snapshot);
    this.notify('update.state', snapshot);
    return snapshot;
  }

  private currentVersion(kind: UpdateKind): string {
    if (kind === 'agent') {
      return updater.activeVersion(this.context()) ?? 'unknown';
    }
    return this.runtime.appVersion ?? process.env.DSH_DESKTOP_VERSION ?? '0.0.0';
  }

  private context() {
    return createDesktopUpdaterContext(this.runtime, this.writeLog);
  }

  private clientContext(): clientUpdater.ClientUpdCtx {
    return this.context();
  }

  private requireKind(value: unknown): UpdateKind {
    if (!isKind(value)) throw new Error('unknown update kind');
    return value;
  }
}
