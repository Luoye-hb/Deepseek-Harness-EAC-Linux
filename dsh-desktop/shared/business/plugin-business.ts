/**
 * Shell-neutral plugin management services.
 *
 * The existing Electron IPC handlers remain adapters. This module owns the
 * profile/settings/patch mutations so the same behavior can be driven by the
 * Tauri desktop-host.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as updater from '../../updater.js';
import * as pluginUpdater from '../../plugin-updater.js';
import {
  COMPANION_PLUGINS,
  PLUGIN_UPDATE_SOURCES,
} from '../../lib/plugin-registry-data.js';
import { collectPluginRows } from '../../plugin-manager-state.js';
import {
  hasEntryId,
  removePluginFromPatch,
  togglePluginInPatch,
} from '../../scripts/plugin-manager-patch.js';
import { CORE_PLUGIN_IDS, type PatchEntry } from '../../scripts/onboarding.js';
import { configLinesFor } from '../../patch-row-heal.js';
import { copyPluginPackage, readJsonFile } from '../../lib/plugin-copy.js';
import { createGuard } from '../../plugin-guard.js';
import {
  createDesktopUpdaterContext,
  type DesktopBusinessRuntime,
} from './desktop-business.js';

const requireModule = createRequire(
  typeof __filename === 'string'
    ? __filename
    : path.join(process.cwd(), 'package.json'),
);

interface PluginBusinessServiceOptions {
  readonly runtime: DesktopBusinessRuntime;
  readonly log?: (tag: string, message: string) => void;
}

interface PluginRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly toggleable: boolean;
  readonly removable: boolean;
  readonly removed: boolean;
  readonly core: boolean;
  readonly group: 'companion' | 'other' | 'core';
}

const IMAGE_PASTE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_PASTE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/ico': '.ico',
  'image/x-icon': '.ico',
  'image/tiff': '.tiff',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class PluginBusinessService {
  private runtime: DesktopBusinessRuntime;
  private readonly writeLog: (tag: string, message: string) => void;

  constructor(options: PluginBusinessServiceOptions) {
    this.runtime = options.runtime;
    this.writeLog = options.log ?? (() => {});
  }

  configure(runtime: Partial<DesktopBusinessRuntime>): void {
    this.runtime = { ...this.runtime, ...runtime };
  }

  /**
   * Rebuild the managed companion-plugin layer before dsh web starts.
   * Electron used to do this in its boot composition; desktop-host must own
   * the same step so a fresh Tauri profile can load client plugins.
   */
  syncCompanionPlugins(): { ok: boolean; synced: string[]; skipped: string[] } {
    this.ensureProfile();
    const profile = this.profileDir();
    const removed = this.removedPluginIds();
    const pending: Array<{
      id: string;
      name: string;
      disabled: boolean;
      config?: Record<string, unknown>;
    }> = [];
    const synced: string[] = [];
    const skipped: string[] = [];

    for (const plugin of COMPANION_PLUGINS) {
      if (removed.has(plugin.id)) {
        skipped.push(plugin.id);
        continue;
      }
      const dirName = plugin.dir ?? (plugin.name.includes('/')
        ? plugin.name.slice(plugin.name.lastIndexOf('/') + 1)
        : plugin.name);
      const source = this.pluginSourceDir(dirName);
      if (!fs.existsSync(path.join(source, 'package.json'))) {
        skipped.push(plugin.id);
        this.writeLog('plugin', `配套插件源目录无效，跳过: ${plugin.id} -> ${source}`);
        continue;
      }
      copyPluginPackage(profile, source, plugin.name);
      pending.push({
        id: plugin.id,
        name: plugin.name,
        disabled: plugin.disabled === true,
        ...(plugin.config === undefined ? {} : { config: plugin.config }),
      });
      synced.push(plugin.id);
    }

    let patch = '';
    const patchFile = path.join(profile, 'cordis.patch.yml');
    try {
      patch = fs.readFileSync(patchFile, 'utf8');
    } catch {
      patch = '[]\n';
    }
    const manifest = readJsonFile(path.join(profile, 'package.json'));
    const bundles = Array.isArray(
      (manifest?.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles,
    )
      ? ((manifest?.dsh as { profile?: { bundles?: unknown } }).profile?.bundles as unknown[])
        .filter((item): item is string => typeof item === 'string')
      : [];
    let changed = false;
    for (const plugin of pending) {
      if (hasEntryId(patch, plugin.id) || bundles.includes(plugin.name)) continue;
      let block = `- insert:\n    - id: ${plugin.id}\n      name: '${plugin.name.replace(/'/g, "''")}'\n`;
      if (plugin.config) block += configLinesFor(plugin.config);
      if (plugin.disabled) block += '      disabled: true\n';
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    if (changed) this.atomicWrite(patchFile, patch);
    return { ok: true, synced, skipped };
  }

  list(): PluginRow[] {
    const { entries } = this.readPatch();
    let bundles: string[] = [];
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(this.profileDir(), 'package.json'), 'utf8'),
      ) as { dsh?: { profile?: { bundles?: unknown } } };
      const candidate = manifest.dsh?.profile?.bundles;
      if (Array.isArray(candidate)) {
        bundles = candidate.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      /* Profile initialization is allowed to lag behind the management page. */
    }
    return collectPluginRows(entries, {
      companion: COMPANION_PLUGINS.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
      })),
      coreIds: CORE_PLUGIN_IDS,
      removedIds: this.removedPluginIds(),
      bundles,
      describe: (name) => this.packageDescription(name),
    }) as PluginRow[];
  }

  setEnabled(id: string, enabled: boolean): { ok: boolean; error?: string; restartRequired?: boolean } {
    const row = this.list().find((item) => item.id === id);
    if (!row) return { ok: false, error: '未知插件: ' + id };
    if (!row.toggleable) return { ok: false, error: '该插件不可关闭: ' + id };
    const name = this.resolveName(id);
    if (!enabled && !name) return { ok: false, error: '无法解析插件包名: ' + id };
    const file = path.join(this.profileDir(), 'cordis.patch.yml');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* The profile may not have been initialized yet. */
    }
    if (!text.trim()) {
      text = '# dsh web profile patch（由 Deepseek Harness EAC 维护）\n';
    }
    try {
      const patched = togglePluginInPatch(text, id, enabled, name);
      if (patched !== text) this.atomicWrite(file, patched);
      this.writeLog('plugin-manager', (enabled ? '已启用' : '已关闭') + '插件 ' + id);
      return { ok: true, restartRequired: true };
    } catch (error) {
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  setRemoved(id: string, removed: boolean): { ok: boolean; error?: string; restartRequired?: boolean } {
    const plugin = COMPANION_PLUGINS.find((item) => item.id === id);
    if (!plugin) return { ok: false, error: '未知内置插件: ' + id };
    if (CORE_PLUGIN_IDS.has(id)) {
      return { ok: false, error: '核心插件不可移除: ' + id };
    }

    try {
      const removedIds = this.removedPluginIds();
      const patchFile = path.join(this.profileDir(), 'cordis.patch.yml');
      if (removed) {
        let text = '';
        try {
          text = fs.readFileSync(patchFile, 'utf8');
        } catch {
          /* No patch is equivalent to an empty patch. */
        }
        const patched = removePluginFromPatch(text, id);
        if (patched !== text) this.atomicWrite(patchFile, patched);
        fs.rmSync(
          path.join(this.profileDir(), 'node_modules', ...plugin.name.split('/')),
          { recursive: true, force: true },
        );
        removedIds.add(id);
        this.saveRemovedPluginIds(removedIds);
        return { ok: true, restartRequired: true };
      }

      removedIds.delete(id);
      this.saveRemovedPluginIds(removedIds);
      const restored = this.restoreCompanion(plugin);
      if (!restored.ok) return restored;
      return { ok: true, restartRequired: true };
    } catch (error) {
      this.writeLog('plugin-manager', '移除/恢复插件失败: ' + String((error as Error).message || error));
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  async listUpdates(force = false): Promise<{
    list: unknown[];
    autoUpdate: boolean;
    checkedAt: string | null;
    error?: string;
  }> {
    try {
      const ctx = this.updaterContext();
      const list = await pluginUpdater.checkPluginUpdates(
        ctx,
        this.updateSources(),
        { force, profileDirP: this.profileDir() },
      );
      const settings = updater.loadSettings(ctx);
      return {
        list,
        autoUpdate: pluginUpdater.isAutoUpdateEnabled(ctx),
        checkedAt: typeof settings.pluginUpdateCheckedAt === 'string'
          ? settings.pluginUpdateCheckedAt
          : null,
      };
    } catch (error) {
      return {
        list: [],
        autoUpdate: false,
        checkedAt: null,
        error: String((error as Error).message || error),
      };
    }
  }

  async update(id: string): Promise<Record<string, unknown>> {
    const source = this.updateSources().find((item) => item.id === id);
    if (!source) {
      return { ok: false, error: '未知或不可更新的内置插件: ' + id };
    }
    try {
      const ctx = this.updaterContext();
      const guard = createGuard({
        getHome: () => this.runtime.dshHome,
        getProfile: () => this.profileName(),
        dshBin: () => this.dshBin(ctx),
        log: this.writeLog,
      });
      const result = await pluginUpdater.applyBuiltinPluginUpdate(ctx, source, {
        profileDirP: this.profileDir(),
        guard,
        copyIntoProfile: (overlayDir, name) =>
          copyPluginPackage(this.profileDir(), overlayDir, name),
      });
      if (!result.ok) return result as unknown as Record<string, unknown>;
      if (result.noop) {
        return {
          ok: true,
          noop: true,
          current: result.current,
          latest: result.latest,
        };
      }
      return {
        ok: true,
        version: result.latest,
        restartRequired: result.restartRequired === true,
      };
    } catch (error) {
      this.writeLog('plugin-update', '更新插件失败: ' + String((error as Error).message || error));
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  setAutoUpdate(enabled: boolean): { ok: boolean; error?: string } {
    try {
      const ctx = this.updaterContext();
      const settings = updater.loadSettings(ctx);
      settings.pluginAutoUpdate = enabled;
      updater.saveSettings(ctx, settings);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error).message || error) };
    }
  }

  guardAction(
    action: string,
    value: unknown,
    serviceRunning: boolean,
  ): unknown {
    const guard = this.guard();
    switch (action) {
      case 'status': {
        const settings = updater.loadSettings(this.updaterContext());
        return {
          ok: true,
          profile: this.profileName(),
          shareWebProfile: settings.shareWebProfile === true,
          snapshots: guard.listSnapshots().slice(0, 20),
          incidents: guard.listIncidents().slice(0, 20),
          lastGood: guard.lastGoodSnapshot(),
        };
      }
      case 'snapshot':
        return { ok: true, snapshot: guard.snapshot(String(value || 'manual')) };
      case 'restore':
        if (serviceRunning) {
          return {
            ok: false,
            error: 'service-running',
            hint: '请先重启 Web 服务（或让回滚在重启间隙执行）',
          };
        }
        return guard.restore(String(value ?? ''));
      case 'check':
        return { ok: true, report: guard.healthCheck() };
      case 'repair':
        return { ok: true, applied: guard.repair().applied };
      case 'incident':
        return guard.readIncident(String(value ?? ''));
      case 'resolve-incident':
        return guard.resolveIncident(String(value ?? ''));
      default:
        return { ok: false, error: 'unknown action' };
    }
  }

  imagePasteSave(dataUrl: unknown, name: unknown): {
    ok: boolean;
    path?: string;
    size?: number;
    error?: string;
  } {
    const raw = String(dataUrl ?? '');
    const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!match?.[1] || !match[2]) {
      return { ok: false, error: '不是合法的图片 data URL' };
    }
    const mime = match[1].toLowerCase();
    const extension = IMAGE_PASTE_EXT[mime];
    if (!extension) return { ok: false, error: '不支持的图片类型: ' + mime };
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) return { ok: false, error: '图片内容为空' };
    if (buffer.length > IMAGE_PASTE_MAX_BYTES) {
      return { ok: false, error: '图片超过 15MB 上限' };
    }
    const directory = path.join(os.tmpdir(), 'dsh-paste');
    fs.mkdirSync(directory, { recursive: true });
    const base =
      String(name ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .trim()
        .slice(0, 40) || '粘贴图片';
    const file = path.join(directory, `${base}-${Date.now()}${extension}`);
    fs.writeFileSync(file, buffer);
    return { ok: true, path: file, size: buffer.length };
  }

  private readPatch(): { file: string; text: string; entries: PatchEntry[] } {
    const file = path.join(this.profileDir(), 'cordis.patch.yml');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { file, text, entries: [] };
    }
    try {
      const yaml = this.loadYaml();
      const parsed = yaml?.load(text);
      return {
        file,
        text,
        entries: Array.isArray(parsed) ? parsed as PatchEntry[] : [],
      };
    } catch {
      return { file, text, entries: [] };
    }
  }

  private packageDescription(name: string): string {
    if (!name) return '';
    const candidates = [
      path.join(this.profileDir(), 'node_modules', ...name.split('/')),
      path.join(this.assetsDir(), name.includes('/') ? name.slice(name.indexOf('/') + 1) : name),
    ];
    for (const directory of candidates) {
      try {
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
        ) as { description?: unknown };
        if (typeof packageJson.description === 'string') return packageJson.description;
      } catch {
        /* Try the next source. */
      }
    }
    return '';
  }

  private resolveName(id: string): string {
    const companion = COMPANION_PLUGINS.find((plugin) => plugin.id === id);
    if (companion) return companion.name;
    const { entries } = this.readPatch();
    for (const entry of entries) {
      const insert = asRecord(entry).insert;
      if (!Array.isArray(insert)) continue;
      const match = insert.find((item) => asRecord(item).id === id);
      if (match && typeof asRecord(match).name === 'string') {
        return String(asRecord(match).name);
      }
    }
    return '';
  }

  private removedPluginIds(): Set<string> {
    const settings = updater.loadSettings(this.updaterContext());
    return new Set(
      Array.isArray(settings.removedPlugins)
        ? settings.removedPlugins.filter((item): item is string => typeof item === 'string')
        : [],
    );
  }

  private saveRemovedPluginIds(ids: Set<string>): void {
    const ctx = this.updaterContext();
    const settings = updater.loadSettings(ctx);
    settings.removedPlugins = Array.from(ids);
    updater.saveSettings(ctx, settings);
  }

  private restoreCompanion(plugin: (typeof COMPANION_PLUGINS)[number]): { ok: boolean; error?: string } {
    const dirName = plugin.dir ?? (plugin.name.includes('/')
      ? plugin.name.slice(plugin.name.lastIndexOf('/') + 1)
      : plugin.name);
    const source = this.pluginSourceDir(dirName);
    if (!fs.existsSync(path.join(source, 'package.json'))) {
      return { ok: false, error: '配套插件源目录无效: ' + source };
    }
    copyPluginPackage(this.profileDir(), source, plugin.name);
    const patchFile = path.join(this.profileDir(), 'cordis.patch.yml');
    let patch = '';
    try {
      patch = fs.readFileSync(patchFile, 'utf8');
    } catch {
      /* Created below. */
    }
    if (hasEntryId(patch, plugin.id)) return { ok: true };
    let bundles: string[] = [];
    const manifest = readJsonFile(path.join(this.profileDir(), 'package.json'));
    const candidate = asRecord(asRecord(manifest).dsh).profile;
    if (Array.isArray(asRecord(candidate).bundles)) {
      bundles = (asRecord(candidate).bundles as unknown[]).filter(
        (item): item is string => typeof item === 'string',
      );
    }
    if (bundles.includes(plugin.name)) return { ok: true };

    let block = `- insert:\n    - id: ${plugin.id}\n      name: '${plugin.name.replace(/'/g, "''")}'\n`;
    if (plugin.config) block += configLinesFor(plugin.config);
    if (plugin.disabled) block += '      disabled: true\n';
    if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
    else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
    else patch = patch.replace(/\s*$/, '\n') + block;
    this.atomicWrite(patchFile, patch);
    return { ok: true };
  }

  private updateSources(): pluginUpdater.PluginSource[] {
    const removed = this.removedPluginIds();
    return COMPANION_PLUGINS.flatMap((plugin) => {
      const update = PLUGIN_UPDATE_SOURCES[plugin.id];
      if (!update || removed.has(plugin.id)) return [];
      const dirName = plugin.dir ?? (plugin.name.includes('/')
        ? plugin.name.slice(plugin.name.lastIndexOf('/') + 1)
        : plugin.name);
      const assetsDir = path.join(this.assetsDir(), dirName);
      if (!fs.existsSync(path.join(assetsDir, 'package.json'))) return [];
      return [{ id: plugin.id, name: plugin.name, assetsDir, update }];
    });
  }

  private profileName(): string {
    return updater.loadSettings(this.updaterContext()).shareWebProfile === true
      ? 'web'
      : 'web-desktop';
  }

  private dshBin(ctx: ReturnType<typeof this.updaterContext>): string {
    const overlay = updater.overlayBinPath(ctx);
    if (overlay && fs.existsSync(overlay)) return overlay;
    return requireModule.resolve('@deepseek-ai/dsh/lib/bin.js');
  }

  private guard() {
    const ctx = this.updaterContext();
    return createGuard({
      getHome: () => this.runtime.dshHome,
      getProfile: () => this.profileName(),
      dshBin: () => this.dshBin(ctx),
      log: this.writeLog,
    });
  }

  private pluginSourceDir(dirName: string): string {
    const assets = path.join(this.assetsDir(), dirName);
    const overlay = path.join(this.runtime.userDataDir, 'builtin-plugin-updates', dirName);
    if (!fs.existsSync(path.join(overlay, 'package.json'))) return assets;
    if (!fs.existsSync(path.join(assets, 'package.json'))) return overlay;
    const overlayPackage = readJsonFile(path.join(overlay, 'package.json'));
    const assetPackage = readJsonFile(path.join(assets, 'package.json'));
    const overlayVersion = String(overlayPackage?.version ?? '');
    const assetVersion = String(assetPackage?.version ?? '');
    return overlayVersion && assetVersion && updater.compareVersions(overlayVersion, assetVersion) < 0
      ? assets
      : overlay;
  }

  private profileDir(): string {
    return path.join(this.runtime.dshHome, 'profiles', this.profileName());
  }

  private ensureProfile(): void {
    const directory = this.profileDir();
    fs.mkdirSync(directory, { recursive: true });
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          name: `dsh-profile-${this.profileName()}`,
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
        }, null, 2) + '\n',
        'utf8',
      );
    }
    const workspace = path.join(directory, 'pnpm-workspace.yaml');
    if (!fs.existsSync(workspace)) {
      fs.writeFileSync(
        workspace,
        'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
        'utf8',
      );
    }
    const patch = path.join(directory, 'cordis.patch.yml');
    if (!fs.existsSync(patch)) fs.writeFileSync(patch, '[]\n', 'utf8');
  }

  private assetsDir(): string {
    return this.runtime.assetsDir ??
      process.env.DSH_DESKTOP_ASSETS?.trim() ??
      path.join(process.cwd(), 'assets', 'plugins');
  }

  private updaterContext() {
    return createDesktopUpdaterContext(this.runtime, this.writeLog);
  }

  private atomicWrite(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  }

  private loadYaml(): { load(content: string): unknown } | null {
    try {
      const yaml = requireModule('js-yaml') as {
        Type: new (tag: string, options: Record<string, unknown>) => unknown;
        JSON_SCHEMA: { extend(type: unknown): unknown };
        load(content: string, options?: { schema?: unknown }): unknown;
      };
      const jsType = new yaml.Type('tag:yaml.org,2002:js', {
        kind: 'scalar',
        resolve: (data: unknown) => typeof data === 'string',
        construct: (data: unknown) => ({ __jsExpr: data }),
      });
      return {
        load: (content) => yaml.load(content, {
          schema: yaml.JSON_SCHEMA.extend(jsType),
        }),
      };
    } catch {
      return null;
    }
  }
}
