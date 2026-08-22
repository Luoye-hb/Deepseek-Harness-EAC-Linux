/** Shell-neutral recovery-center operations. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as updater from '../../updater.js';
import type { DesktopBusinessRuntime } from './desktop-business.js';
import { createDesktopUpdaterContext } from './desktop-business.js';
import { PluginBusinessService } from './plugin-business.js';

interface RegistryRecord {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly source?: unknown;
  readonly risk?: unknown;
  readonly kind?: unknown;
  readonly state?: unknown;
  readonly enabled?: unknown;
  readonly lastError?: unknown;
  readonly lastErrorAt?: unknown;
  readonly [key: string]: unknown;
}

interface RegistryFile {
  readonly plugins?: Record<string, RegistryRecord>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface RecoveryBusinessServiceOptions {
  readonly runtime: DesktopBusinessRuntime;
  readonly log?: (tag: string, message: string) => void;
}

export class RecoveryBusinessService {
  private runtime: DesktopBusinessRuntime;
  private readonly writeLog: (tag: string, message: string) => void;
  private readonly plugins: PluginBusinessService;

  constructor(options: RecoveryBusinessServiceOptions) {
    this.runtime = options.runtime;
    this.writeLog = options.log ?? (() => {});
    this.plugins = new PluginBusinessService({
      runtime: this.runtime,
      log: this.writeLog,
    });
  }

  configure(runtime: Partial<DesktopBusinessRuntime>): void {
    this.runtime = { ...this.runtime, ...runtime };
    this.plugins.configure(runtime);
  }

  status(serviceRunning: boolean, appVersion: string): Record<string, unknown> {
    const guard = asRecord(this.plugins.guardAction('status', null, serviceRunning));
    return {
      ok: true,
      appVersion,
      profile: this.profileName(),
      plugins: this.registryEntries(),
      snapshots: Array.isArray(guard.snapshots) ? guard.snapshots.slice(0, 20) : [],
      incidents: Array.isArray(guard.incidents) ? guard.incidents.slice(0, 20) : [],
      fence: {
        mode: process.platform === 'win32' ? 'win32-job' : 'posix-process-group',
        limitation: 'desktop-host 由 Tauri Rust 监管；Extension Host 围栏能力按平台实现',
      },
    };
  }

  action(
    action: unknown,
    value: unknown,
    serviceRunning: boolean,
  ): unknown {
    const name = String(action ?? '');
    const id = String(value ?? '');
    switch (name) {
      case 'disable':
        return this.mutateEnabled(id, false);
      case 'enable':
        return this.mutateEnabled(id, true);
      case 'remove': {
        const result = this.plugins.setRemoved(id, true);
        if (result.ok) this.setRegistryState(id, 'disabled', false);
        return result;
      }
      case 'quarantine':
        return this.setRegistryState(id, 'quarantined');
      case 'unquarantine':
        return this.setRegistryState(id, undefined);
      case 'snapshot':
        return this.plugins.guardAction('snapshot', value, serviceRunning);
      case 'rollback-last-good': {
        const state = asRecord(this.plugins.guardAction('status', null, serviceRunning));
        const lastGood = asRecord(state.lastGood);
        if (!lastGood.id) return { ok: false, error: 'no-good-snapshot' };
        return this.plugins.guardAction('restore', lastGood.id, serviceRunning);
      }
      case 'read-log':
        return this.readLog(value);
      default:
        return { ok: false, error: 'unknown action' };
    }
  }

  private mutateEnabled(id: string, enabled: boolean): unknown {
    const result = this.plugins.setEnabled(id, enabled);
    if (result.ok) this.setRegistryState(id, enabled ? 'installed' : 'disabled', enabled);
    return result;
  }

  private registryPath(): string {
    return path.join(this.runtime.dshHome, 'extensions', 'registry.json');
  }

  private registryEntries(): unknown[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryPath(), 'utf8')) as RegistryFile;
      const entries = Object.values(raw.plugins ?? {});
      if (entries.length > 0) return entries.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    } catch {
      /* A missing or corrupt registry must not make recovery unavailable. */
    }
    return this.plugins.list().map((plugin) => ({
      id: plugin.id,
      version: '',
      source: plugin.group === 'core' ? 'builtin' : 'market',
      risk: 'legacy-cordis',
      kind: 'legacy',
      state: plugin.enabled ? 'installed' : 'disabled',
      enabled: plugin.enabled,
      crashStreak: 0,
    }));
  }

  private setRegistryState(
    id: string,
    state: string | undefined,
    enabled?: boolean,
  ): { ok: boolean; error?: string } {
    try {
      const file = this.registryPath();
      let parsed: RegistryFile = { plugins: {} };
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RegistryFile;
      } catch {
        /* Start with an empty registry for installations without records. */
      }
      const plugins = { ...(parsed.plugins ?? {}) };
      const current = plugins[id];
      if (!current) return { ok: false, error: '注册表中无此插件档案' };
      const next: Record<string, unknown> = { ...current };
      if (state === undefined) {
        next.state = next.enabled === false ? 'disabled' : 'installed';
      } else {
        next.state = state;
      }
      if (enabled !== undefined) next.enabled = enabled;
      const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      plugins[id] = next as RegistryRecord;
      fs.writeFileSync(temp, JSON.stringify({ ...parsed, plugins }, null, 2) + '\n', 'utf8');
      fs.renameSync(temp, file);
      return { ok: true };
    } catch (error) {
      this.writeLog('recovery', `注册表状态更新失败: ${String((error as Error).message || error)}`);
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  private readLog(value: unknown): { ok: boolean; tail?: string; error?: string } {
    const name = String(value || 'desktop.log');
    if (!['desktop.log', 'dsh-web.log'].includes(name)) return { ok: false, error: 'forbidden' };
    try {
      const file = path.join(this.logsDir(), name);
      const stat = fs.statSync(file);
      const length = Math.min(stat.size, 32 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, tail: buffer.toString('utf8') };
    } catch (error) {
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  private logsDir(): string {
    return this.runtime.logsDir ?? path.join(this.runtime.userDataDir, 'logs');
  }

  private profileName(): string {
    const settings = updater.loadSettings(createDesktopUpdaterContext(this.runtime, this.writeLog));
    return settings.shareWebProfile === true ? 'web' : 'web-desktop';
  }
}
