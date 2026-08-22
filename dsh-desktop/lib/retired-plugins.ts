import * as fs from 'node:fs';
import * as path from 'node:path';
import { removePluginFromPatch } from '../scripts/plugin-manager-patch.js';

export interface RetiredBuiltinPlugin {
  id: string;
  name: string;
}

/** Plugins removed from the distribution and cleaned from existing profiles. */
export const RETIRED_BUILTIN_PLUGINS: readonly RetiredBuiltinPlugin[] = [
  { id: 'tdai-memory', name: 'dsh-tdai-memory' },
  { id: 'auto-compact', name: 'dsh-auto-compact' },
];

export interface RetiredPluginCleanupResult {
  rows: string[];
  packages: string[];
  manifests: string[];
}

function writeAtomic(file: string, content: string): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** Remove retired plugin rows, packages, dependency entries, bundles, and marker names. */
export function retireRemovedBuiltinPlugins(
  profileDir: string,
  report: (message: string) => void = () => {},
): RetiredPluginCleanupResult {
  const result: RetiredPluginCleanupResult = { rows: [], packages: [], manifests: [] };
  const patchFile = path.join(profileDir, 'cordis.patch.yml');

  try {
    const original = fs.readFileSync(patchFile, 'utf8');
    let next = original;
    for (const plugin of RETIRED_BUILTIN_PLUGINS) {
      const cleaned = removePluginFromPatch(next, plugin.id);
      if (cleaned !== next) result.rows.push(plugin.id);
      next = cleaned;
    }
    if (next !== original) writeAtomic(patchFile, next);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      report('清理退役插件 profile 行失败: ' + String((error as Error).message));
    }
  }

  for (const plugin of RETIRED_BUILTIN_PLUGINS) {
    const packageDir = path.join(profileDir, 'node_modules', ...plugin.name.split('/'));
    try {
      if (fs.existsSync(packageDir)) {
        fs.rmSync(packageDir, { recursive: true, force: true, maxRetries: 2 });
        result.packages.push(plugin.name);
      }
    } catch (error) {
      report(`清理退役插件 ${plugin.id} 包失败: ${String((error as Error).message)}`);
    }
  }

  for (const fileName of ['package.json', '.dsh-builtin-plugins.json']) {
    const file = path.join(profileDir, fileName);
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      let changed = false;
      if (fileName === 'package.json') {
        const dependencies = manifest.dependencies as Record<string, unknown> | undefined;
        const dsh = manifest.dsh as { profile?: { bundles?: unknown[] } } | undefined;
        for (const plugin of RETIRED_BUILTIN_PLUGINS) {
          if (dependencies && Object.hasOwn(dependencies, plugin.name)) {
            delete dependencies[plugin.name];
            changed = true;
          }
          const bundles = dsh?.profile?.bundles;
          if (Array.isArray(bundles)) {
            const filtered = bundles.filter((name) => name !== plugin.name);
            if (filtered.length !== bundles.length && dsh?.profile) {
              dsh.profile.bundles = filtered;
              changed = true;
            }
          }
        }
      } else if (Array.isArray(manifest.names)) {
        const retiredNames = new Set(RETIRED_BUILTIN_PLUGINS.map((plugin) => plugin.name));
        const filtered = manifest.names.filter((name) => !retiredNames.has(String(name)));
        if (filtered.length !== manifest.names.length) {
          manifest.names = filtered;
          changed = true;
        }
      }
      if (changed) {
        writeAtomic(file, JSON.stringify(manifest, null, 2) + '\n');
        result.manifests.push(fileName);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report(`清理退役插件 ${fileName} 失败: ${String((error as Error).message)}`);
      }
    }
  }

  for (const id of result.rows) report(`已清理退役插件 ${id} 的 profile 行`);
  for (const name of result.packages) report(`已清理退役插件 ${name} 的 profile 包`);
  return result;
}
