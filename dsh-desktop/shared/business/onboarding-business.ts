/**
 * Shell-neutral built-in plugin onboarding service.
 *
 * The Electron window and the Tauri window use the same catalog, selection
 * sanitization and profile mutation rules. Window ownership and lifecycle
 * remain in the shell adapter.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as updater from '../../updater.js';
import * as onboardingLogic from '../../scripts/onboarding.js';
import { COMPANION_PLUGINS } from '../../lib/plugin-registry-data.js';
import { PluginBusinessService } from './plugin-business.js';
import {
  createDesktopUpdaterContext,
  type DesktopBusinessRuntime,
} from './desktop-business.js';
import type {
  OnboardingListResult,
  OnboardingMode,
  OnboardingSubmitResult,
} from '../contract/onboarding.js';

const requireModule = createRequire(
  typeof __filename === 'string'
    ? __filename
    : path.join(process.cwd(), 'package.json'),
);

function asMode(value: unknown): OnboardingMode {
  return value === 'rerun' ? 'rerun' : 'first';
}

function profileName(runtime: DesktopBusinessRuntime): string {
  const settings = updater.loadSettings(
    createDesktopUpdaterContext(runtime, () => {}),
  );
  return settings.shareWebProfile === true ? 'web' : 'web-desktop';
}

function profileDir(runtime: DesktopBusinessRuntime): string {
  return path.join(runtime.dshHome, 'profiles', profileName(runtime));
}

function assetsDir(runtime: DesktopBusinessRuntime): string {
  return runtime.assetsDir ??
    process.env.DSH_DESKTOP_ASSETS?.trim() ??
    path.join(process.cwd(), 'assets', 'plugins');
}

function packageDescription(runtime: DesktopBusinessRuntime, name: string): string {
  const candidates = [
    path.join(profileDir(runtime), 'node_modules', ...name.split('/')),
    path.join(assetsDir(runtime), name.includes('/') ? name.slice(name.indexOf('/') + 1) : name),
  ];
  for (const directory of candidates) {
    try {
      const value = JSON.parse(
        fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
      ) as { description?: unknown };
      if (typeof value.description === 'string') return value.description;
    } catch {
      /* Try the next source. */
    }
  }
  return '';
}

function directorySize(runtime: DesktopBusinessRuntime, directory: string): number {
  let total = 0;
  const root = path.join(assetsDir(runtime), directory);
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* A disappearing asset is reported as zero bytes. */
        }
      }
    }
  };
  walk(root);
  return total;
}

function parsePatch(runtime: DesktopBusinessRuntime): onboardingLogic.PatchEntry[] {
  const file = path.join(profileDir(runtime), 'cordis.patch.yml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const yaml = requireModule('js-yaml') as {
      load(content: string): unknown;
    };
    const parsed = yaml.load(text);
    return Array.isArray(parsed) ? parsed as onboardingLogic.PatchEntry[] : [];
  } catch {
    return [];
  }
}

export interface OnboardingBusinessServiceOptions {
  readonly runtime: DesktopBusinessRuntime;
  readonly log?: (tag: string, message: string) => void;
}

export class OnboardingBusinessService {
  private runtime: DesktopBusinessRuntime;
  private readonly writeLog: (tag: string, message: string) => void;
  private readonly plugins: PluginBusinessService;

  constructor(options: OnboardingBusinessServiceOptions) {
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

  list(mode: unknown): OnboardingListResult {
    const normalized = asMode(mode);
    const catalog = onboardingLogic.buildCatalog(COMPANION_PLUGINS, {
      coreIds: onboardingLogic.CORE_PLUGIN_IDS,
      recommendedIds: onboardingLogic.RECOMMENDED_PLUGIN_IDS,
      describe: (name) => packageDescription(this.runtime, name),
      dirSize: (directory) => directorySize(this.runtime, directory),
    });
    return {
      mode: normalized,
      catalog,
      current: normalized === 'rerun'
        ? onboardingLogic.pluginCurrentState(
          parsePatch(this.runtime),
          COMPANION_PLUGINS,
        )
        : null,
    };
  }

  submit(mode: unknown, ids: unknown): OnboardingSubmitResult {
    const normalized = asMode(mode);
    this.ensureProfile();
    const want = onboardingLogic.sanitizeSelection(
      ids,
      COMPANION_PLUGINS,
      onboardingLogic.CORE_PLUGIN_IDS,
    );
    const current = normalized === 'rerun'
      ? onboardingLogic.pluginCurrentState(parsePatch(this.runtime), COMPANION_PLUGINS)
      : null;
    const operations = onboardingLogic.buildSelectionOps(
      COMPANION_PLUGINS,
      onboardingLogic.CORE_PLUGIN_IDS,
      want,
      current,
    );
    const errors: string[] = [];
    for (const operation of operations) {
      const result = this.plugins.setEnabled(operation.id, operation.enable);
      if (!result.ok) {
        errors.push(`${operation.id}: ${result.error ?? 'unknown error'}`);
      }
    }
    const settings = updater.loadSettings(this.updaterContext());
    settings.pluginOnboardingDone = true;
    settings.builtinPluginSelection = Array.from(want);
    updater.saveSettings(this.updaterContext(), settings);
    this.writeLog(
      'onboarding',
      `插件选择向导已应用：${operations.length} 个状态变更`,
    );
    return {
      ok: true,
      applied: operations.length,
      errors,
    };
  }

  cancel(): { ok: true; cancelled: true } {
    const settings = updater.loadSettings(this.updaterContext());
    settings.pluginOnboardingDone = true;
    updater.saveSettings(this.updaterContext(), settings);
    this.writeLog('onboarding', '用户关闭插件选择向导：保持当前插件状态');
    return { ok: true, cancelled: true };
  }

  needsOnboarding(): boolean {
    const settingsPath = updater.settingsPath(this.updaterContext());
    // Capture existence before reading settings. A corrupted legacy settings file
    // may be moved aside during recovery, but it still identifies an existing user.
    const settingsFileExists = fs.existsSync(settingsPath);
    const profileDirExists = fs.existsSync(path.join(profileDir(this.runtime), 'node_modules'));
    const sharedProfileExists = fs.existsSync(
      path.join(this.runtime.dshHome, 'profiles', 'web'),
    );
    const settings = updater.loadSettings(this.updaterContext()) as Record<string, unknown>;
    return onboardingLogic.needsPluginOnboarding({
      settings,
      settingsFileExists,
      profileDirExists,
      sharedProfileExists,
    });
  }

  private ensureProfile(): void {
    const directory = profileDir(this.runtime);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          name: `dsh-profile-${profileName(this.runtime)}`,
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

  private updaterContext() {
    return createDesktopUpdaterContext(this.runtime, this.writeLog);
  }
}
