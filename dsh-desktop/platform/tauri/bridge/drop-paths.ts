export interface NativeDropFile {
  readonly name?: string;
  readonly size?: number;
}

export interface NativeDropPath {
  readonly path: string;
  readonly name: string;
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function fileKey(value: string): string {
  return value.toLocaleLowerCase();
}

/**
 * Associates browser File objects with paths from the current native drop.
 * The weak map prevents a page from turning an arbitrary File into a path;
 * entries are only created while a native drag/drop transaction is active.
 */
export class DropPathResolver {
  private paths: NativeDropPath[] = [];
  private filePaths = new WeakMap<object, string>();
  private clearTimer: ReturnType<typeof setTimeout> | undefined;

  begin(paths: readonly string[]): void {
    this.paths = paths
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .map((path) => ({ path, name: basename(path) }));
    this.scheduleClear();
  }

  associate(files: readonly NativeDropFile[]): void {
    const remaining = this.paths.map((entry, index) => ({ entry, index }));
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const name = typeof file.name === 'string' ? file.name : '';
      const byName = name
        ? remaining.findIndex(({ entry }) => fileKey(entry.name) === fileKey(name))
        : -1;
      const matchIndex = byName >= 0 ? byName : remaining.length > 0 ? 0 : -1;
      if (matchIndex < 0) continue;
      const [match] = remaining.splice(matchIndex, 1);
      if (match) this.filePaths.set(file, match.entry.path);
    }
    this.scheduleClear();
  }

  resolve(file: unknown): string {
    if (!file || (typeof file !== 'object' && typeof file !== 'function')) return '';
    return this.filePaths.get(file) ?? '';
  }

  clear(): void {
    if (this.clearTimer !== undefined) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
    this.paths = [];
    this.filePaths = new WeakMap<object, string>();
  }

  private scheduleClear(): void {
    if (this.clearTimer !== undefined) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => this.clear(), 250);
  }
}
