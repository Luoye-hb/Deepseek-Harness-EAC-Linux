/**
 * Keep the profile's shared module fallback usable for a bundled desktop
 * runtime. DSH plugins resolve from <DSH_HOME>/profiles/<profile> first and
 * then from <DSH_HOME>/profiles/node_modules. Electron's app boot normally
 * maintains that fallback; the shell-neutral host must cover fresh Tauri
 * profiles as well.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProfileRuntimeClosureResult {
  readonly ok: boolean;
  readonly linked: string[];
  readonly repaired: string[];
  readonly skipped: string[];
  readonly error?: string;
}

function removeLink(file: string): void {
  try {
    fs.unlinkSync(file);
    return;
  } catch {
    /* Windows junctions may need the recursive fallback. */
  }
  fs.rmSync(file, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
}

function linkType(): fs.symlink.Type {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function packageEntries(root: string): Array<{ name: string; relative: string }> {
  const result: Array<{ name: string; relative: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name.startsWith('.')) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.name.startsWith('@')) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.name.startsWith('.') || (!child.isDirectory() && !child.isSymbolicLink())) continue;
        const relative = path.join(entry.name, child.name);
        if (fs.existsSync(path.join(root, relative, 'package.json'))) {
          result.push({ name: entry.name + '/' + child.name, relative });
        }
      }
      continue;
    }
    if ((entry.isDirectory() || entry.isSymbolicLink()) && fs.existsSync(path.join(entryPath, 'package.json'))) {
      result.push({ name: entry.name, relative: entry.name });
    }
  }
  return result;
}

function normalizedPath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, value: string): boolean {
  const expected = normalizedPath(root);
  const actual = normalizedPath(value);
  return actual === expected || actual.startsWith(expected + '/');
}

/**
 * Add or repair fallback links for every package in the bundled Node module
 * closure. Existing real directories are preserved because they may be a
 * user-managed package; the existing plugin guard can report those shadows.
 */
export function ensureProfileRuntimeClosure(
  dshHome: string,
  dshBin: string,
  log: (message: string) => void = (): void => {},
): ProfileRuntimeClosureResult {
  const linked: string[] = [];
  const repaired: string[] = [];
  const skipped: string[] = [];
  try {
    const sourceRoot = path.resolve(dshBin, '../../../..');
    if (!fs.existsSync(path.join(sourceRoot, '@deepseek-ai', 'dsh', 'package.json'))) {
      throw new Error(`bundled dsh closure is missing: ${sourceRoot}`);
    }
    const realSourceRoot = fs.realpathSync(sourceRoot);
    const fallbackRoot = path.join(path.resolve(dshHome), 'profiles', 'node_modules');
    fs.mkdirSync(fallbackRoot, { recursive: true });

    for (const entry of packageEntries(sourceRoot)) {
      const source = path.join(sourceRoot, entry.relative);
      const destination = path.join(fallbackRoot, entry.relative);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(destination);
      } catch {
        stat = undefined;
      }

      if (!stat) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(source, destination, linkType());
        linked.push(entry.name);
        continue;
      }
      if (!stat.isSymbolicLink()) {
        skipped.push(entry.name);
        continue;
      }

      let healthy = false;
      try {
        const realDestination = fs.realpathSync(destination);
        healthy =
          isWithin(realSourceRoot, realDestination) &&
          fs.existsSync(path.join(realDestination, 'package.json'));
      } catch {
        healthy = false;
      }
      if (healthy) continue;

      removeLink(destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(source, destination, linkType());
      repaired.push(entry.name);
    }
    if (linked.length || repaired.length) {
      log(`profile module fallback ready: linked=${linked.length}, repaired=${repaired.length}`);
    }
    return { ok: true, linked, repaired, skipped };
  } catch (error) {
    const message = String((error as Error).message || error);
    log('profile module fallback failed: ' + message);
    return { ok: false, linked, repaired, skipped, error: message };
  }
}
