/** Durable desktop settings storage shared by updater and the application shell. */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CURRENT_SCHEMA_VERSION = 1;
const BOOLEAN_KEYS = [
  'notifyOnTurnEnd', 'closeToTray', 'shareWebProfile', 'pluginAutoUpdate',
  'pluginOnboardingDone', 'autoUpdate', 'clientAutoUpdate',
] as const;

export interface SettingsContext {
  userDataDir: string;
  log(tag: string, msg: string): void;
}

type SettingsWriteFileSystem = Pick<typeof fs,
  'mkdirSync' | 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' |
  'renameSync' | 'rmSync' | 'existsSync' | 'chmodSync'>;

/** settings.json fields owned by the desktop shell; unknown extensions survive. */
export interface DshSettings {
  schemaVersion?: number;
  shareWebProfile?: boolean;
  closeToTray?: boolean;
  shortcutPolicy?: string;
  previousAgent?: { version: string; dir?: string; at?: string } | null;
  skipVersion?: string | null;
  skipClientVersion?: string | null;
  pendingClientUpdate?: { version?: string; path?: string; source?: string } | null;
  [key: string]: unknown;
}

export function settingsPath(ctx: SettingsContext): string {
  return path.join(ctx.userDataDir, 'settings.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function settingsPathFromArtifact(file: string): string {
  const marker = file.indexOf('.tmp-');
  if (marker >= 0) return file.slice(0, marker);
  return file.endsWith('.backup') ? file.slice(0, -'.backup'.length) : file;
}

function evidencePath(file: string, suffix: string): string {
  const base = `${settingsPathFromArtifact(file)}.${suffix}-${Date.now()}`;
  let candidate = base;
  for (let i = 1; fs.existsSync(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

function preserveEvidence(file: string, suffix: string): string | null {
  if (!fs.existsSync(file)) return null;
  const evidence = evidencePath(file, suffix);
  try {
    fs.renameSync(file, evidence);
    return evidence;
  } catch {
    try {
      fs.copyFileSync(file, evidence);
      fs.rmSync(file, { force: true });
      return evidence;
    } catch {
      return null;
    }
  }
}

function normalizeSettings(value: unknown, ctx: SettingsContext): DshSettings {
  if (!isPlainObject(value)) {
    ctx.log('settings', 'settings.json 顶层不是对象，使用空设置');
    return { schemaVersion: CURRENT_SCHEMA_VERSION };
  }
  const out: Record<string, unknown> = { ...value, schemaVersion: CURRENT_SCHEMA_VERSION };
  for (const key of BOOLEAN_KEYS) {
    if (key in out && typeof out[key] !== 'boolean') delete out[key];
  }
  if ('webPort' in out && (!Number.isInteger(out.webPort) || Number(out.webPort) < 0 || Number(out.webPort) > 65535)) delete out.webPort;
  if ('shortcutPolicy' in out && !['auto', 'never'].includes(String(out.shortcutPolicy))) delete out.shortcutPolicy;
  if ('exitAction' in out && !['ask', 'minimize', 'quit'].includes(String(out.exitAction))) delete out.exitAction;
  for (const key of ['removedPlugins', 'builtinPluginSelection']) {
    if (!(key in out)) continue;
    if (!Array.isArray(out[key])) delete out[key];
    else out[key] = (out[key] as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  return out as DshSettings;
}

function readValidated(file: string, ctx: SettingsContext): DshSettings {
  return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, ctx);
}

function syncDirectory(dir: string, fileSystem: Pick<SettingsWriteFileSystem, 'openSync' | 'fsyncSync' | 'closeSync'> = fs): void {
  let fd: number | undefined;
  try {
    fd = fileSystem.openSync(dir, 'r');
    fileSystem.fsyncSync(fd);
  } catch {
    // Windows does not support opening directories for fsync.
  } finally {
    if (fd !== undefined) fileSystem.closeSync(fd);
  }
}

function recoverInterruptedWrite(file: string, ctx: SettingsContext): void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const backup = `${file}.backup`;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const temps = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${base}.tmp-`))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
  const validTemps: string[] = [];
  for (const temp of temps) {
    try {
      readValidated(temp, ctx);
      validTemps.push(temp);
    } catch {
      const evidence = preserveEvidence(temp, 'corrupt-temp');
      ctx.log('settings', `无效临时设置已保留${evidence ? `: ${evidence}` : ''}`);
    }
  }

  if (fs.existsSync(file)) {
    for (const temp of validTemps) fs.rmSync(temp, { force: true });
    try {
      readValidated(file, ctx);
      fs.rmSync(backup, { force: true });
    } catch {
      // loadSettings preserves the corrupt primary, then calls us again to restore backup.
    }
    return;
  }

  for (const temp of validTemps) {
    try {
      fs.renameSync(temp, file);
      fs.chmodSync(file, 0o600);
      syncDirectory(dir);
      ctx.log('settings', '恢复中断写入的 settings.json 临时文件');
      for (const stale of validTemps) {
        if (stale !== temp) {
          try { fs.rmSync(stale, { force: true }); } catch { /* best effort */ }
        }
      }
      try { fs.rmSync(backup, { force: true }); } catch { /* best effort */ }
      return;
    } catch {
      // Another process may have completed recovery first; try the next candidate.
    }
  }

  if (!fs.existsSync(backup)) return;
  try {
    readValidated(backup, ctx);
    fs.renameSync(backup, file);
    fs.chmodSync(file, 0o600);
    syncDirectory(dir);
    ctx.log('settings', '恢复 Windows 替换中断前的 settings.json 备份');
  } catch {
    const evidence = preserveEvidence(backup, 'corrupt-backup');
    ctx.log('settings', `无效设置备份已保留${evidence ? `: ${evidence}` : ''}`);
  }
}

export function loadSettings(ctx: SettingsContext): DshSettings {
  const file = settingsPath(ctx);
  recoverInterruptedWrite(file, ctx);
  try {
    const value = readValidated(file, ctx);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    return value;
  } catch (err) {
    if (!fs.existsSync(file)) return {};
    const evidence = preserveEvidence(file, 'corrupt');
    ctx.log('settings', `settings.json 损坏，已保留证据${evidence ? ` ${evidence}` : ''}: ${String((err as Error).message)}`);
    recoverInterruptedWrite(file, ctx);
    try { return readValidated(file, ctx); } catch { return {}; }
  }
}

export function saveSettings(
  ctx: SettingsContext,
  settings: DshSettings,
  fileSystem: SettingsWriteFileSystem = fs,
): void {
  const file = settingsPath(ctx);
  const dir = path.dirname(file);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const backup = `${file}.backup`;
  let fd: number | undefined;
  try {
    const value = normalizeSettings(isPlainObject(settings) ? settings : {}, ctx);
    fileSystem.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = fileSystem.openSync(temp, 'wx', 0o600);
    fileSystem.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd);
    fd = undefined;

    try {
      fileSystem.renameSync(temp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(String(code))) throw err;
      fileSystem.rmSync(backup, { force: true });
      if (fileSystem.existsSync(file)) fileSystem.renameSync(file, backup);
      try {
        fileSystem.renameSync(temp, file);
      } catch (replaceErr) {
        if (!fileSystem.existsSync(file) && fileSystem.existsSync(backup)) fileSystem.renameSync(backup, file);
        throw replaceErr;
      }
      fileSystem.rmSync(backup, { force: true });
    }
    fileSystem.chmodSync(file, 0o600);
    syncDirectory(dir, fileSystem);
  } catch (err) {
    if (fd !== undefined) {
      try { fileSystem.closeSync(fd); } catch { /* already closed */ }
    }
    ctx.log('settings', '保存 settings 失败: ' + String((err as Error).message));
  } finally {
    try { fileSystem.rmSync(temp, { force: true }); } catch { /* keep recovery best effort */ }
  }
}
