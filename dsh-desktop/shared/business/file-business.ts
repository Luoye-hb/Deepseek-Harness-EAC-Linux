/**
 * Shell-neutral file operations used by the file-changes and file-drop
 * plugins.
 *
 * Native opening is intentionally outside this module. This service validates
 * the path and performs content-safe revert operations; the Tauri/Rust or
 * Electron adapter performs the final system-open action.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { scanZstdFrames } from '../../session-watcher.js';
import type { DesktopBusinessRuntime } from './desktop-business.js';

const DANGEROUS_EXT =
  /\.(bat|cmd|com|exe|ps1|vbs|lnk|js|jse|msi|scr|pif|reg)$/i;

interface RevertChange {
  path?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

export interface RevertResult {
  readonly path: string;
  readonly status: string;
  readonly error?: string;
}

export interface FileBusinessServiceOptions {
  readonly runtime: DesktopBusinessRuntime;
  readonly fileRoots?: () => readonly string[];
}

export class FileBusinessService {
  private runtime: DesktopBusinessRuntime;
  private readonly injectedRoots: (() => readonly string[]) | undefined;
  private rootsAt = 0;
  private roots: string[] = [];

  constructor(options: FileBusinessServiceOptions) {
    this.runtime = options.runtime;
    this.injectedRoots = options.fileRoots;
  }

  configure(runtime: Partial<DesktopBusinessRuntime>): void {
    this.runtime = { ...this.runtime, ...runtime };
    this.rootsAt = 0;
  }

  revert(changes: unknown): { results: RevertResult[] } {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) {
      return { results: [] };
    }
    const results: RevertResult[] = [];
    for (const change of changes as RevertChange[]) {
      const file = String(change?.path ?? '');
      const oldText = String(change?.oldText ?? '');
      const newText = String(change?.newText ?? '');
      if (
        !path.isAbsolute(file) ||
        oldText.length > 400_000 ||
        newText.length > 400_000
      ) {
        results.push({ path: file, status: 'invalid' });
        continue;
      }
      if (!this.isUnderFileRoots(file)) {
        results.push({ path: file, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(file);
        const content = exists ? fs.readFileSync(file, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          if (content !== null && content === newText) {
            fs.rmSync(file);
            results.push({ path: file, status: 'reverted' });
          } else {
            results.push({
              path: file,
              status: content === null ? 'missing' : 'conflict',
            });
          }
        } else if (newText === '' && oldText !== '') {
          if (content === null) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, oldText, 'utf8');
            results.push({ path: file, status: 'reverted' });
          } else {
            results.push({ path: file, status: 'conflict' });
          }
        } else if (content !== null && content.includes(newText)) {
          fs.writeFileSync(file, content.replace(newText, oldText), 'utf8');
          results.push({ path: file, status: 'reverted' });
        } else if (content !== null && content === oldText) {
          results.push({ path: file, status: 'skipped' });
        } else {
          results.push({
            path: file,
            status: content === null ? 'missing' : 'conflict',
          });
        }
      } catch (error) {
        results.push({
          path: file,
          status: 'failed',
          error: String((error as Error).message || error),
        });
      }
    }
    return { results };
  }

  validateOpen(file: unknown): { ok: boolean; error?: string; path?: string } {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      return { ok: false, error: 'path must be absolute' };
    }
    const resolved = path.resolve(file);
    const skillsRoots = [
      path.join(this.runtime.dshHome, 'skills'),
      path.join(
        process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'),
        'skills',
      ),
    ];
    const underSkillsRoot = skillsRoots.some((root) => this.isUnder(resolved, root));
    if (!underSkillsRoot && !this.isUnderFileRoots(resolved)) {
      return { ok: false, error: 'path outside session workspace' };
    }
    if (DANGEROUS_EXT.test(resolved)) {
      return {
        ok: false,
        error: 'executable files are not openable from the file view',
      };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file not found' };
    return { ok: true, path: resolved };
  }

  private isUnderFileRoots(file: string): boolean {
    return this.fileRoots().some((root) => this.isUnder(file, root));
  }

  private isUnder(file: string, root: string): boolean {
    const resolved = path.resolve(file);
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  }

  private fileRoots(): readonly string[] {
    if (this.injectedRoots) return this.injectedRoots();
    if (Date.now() - this.rootsAt < 5 * 60 * 1000) return this.roots;
    const roots: string[] = [];
    const walk = (directory: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(candidate);
          continue;
        }
        if (entry.name !== 'session.jsonl.zstd') continue;
        try {
          const buffer = fs.readFileSync(candidate);
          const { frames } = scanZstdFrames(buffer);
          const first = frames[0];
          if (!first) continue;
          const text = zlib.zstdDecompressSync(
            buffer.subarray(first.start, first.end),
          ).toString('utf8');
          const header = JSON.parse(text.split('\n', 1)[0] ?? '') as {
            cwd?: unknown;
          };
          if (typeof header.cwd === 'string' && header.cwd) roots.push(header.cwd);
        } catch {
          /* Corrupt session logs do not widen the file boundary. */
        }
      }
    };
    walk(path.join(this.runtime.dshHome, 'sessions'));
    this.roots = [...new Set(roots)];
    this.rootsAt = Date.now();
    return this.roots;
  }
}
