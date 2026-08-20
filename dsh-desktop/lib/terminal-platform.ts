import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TerminalShimSet {
  binDir: string;
  node: string;
  npm: string;
  npx: string;
}

export interface LinuxTerminalAdapter {
  command: 'x-terminal-emulator' | 'gnome-terminal' | 'konsole' | 'xfce4-terminal';
  args(shellPath: string): string[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/** Create user-writable node/npm/npx launchers backed only by bundled files. */
export function createTerminalShims(
  userDataDir: string,
  nodePath: string,
  npmCliPath: string,
  platform: NodeJS.Platform = process.platform,
): TerminalShimSet {
  const binDir = path.join(userDataDir, 'terminal-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const npxCliPath = path.join(path.dirname(npmCliPath), 'npx-cli.js');
  if (platform === 'win32') {
    const cmd = (cliPath: string): string =>
      `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n`;
    const npm = path.join(binDir, 'npm.cmd');
    const npx = path.join(binDir, 'npx.cmd');
    fs.writeFileSync(npm, cmd(npmCliPath));
    fs.writeFileSync(npx, cmd(npxCliPath));
    return { binDir, node: nodePath, npm, npx };
  }

  const node = path.join(binDir, 'node');
  const npm = path.join(binDir, 'npm');
  const npx = path.join(binDir, 'npx');
  writeExecutable(node, `#!/bin/sh\nexec ${shellQuote(nodePath)} "$@"\n`);
  writeExecutable(npm, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(npmCliPath)} "$@"\n`);
  writeExecutable(npx, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(npxCliPath)} "$@"\n`);
  return { binDir, node, npm, npx };
}

export function linuxTerminalAdapters(): LinuxTerminalAdapter[] {
  return [
    { command: 'x-terminal-emulator', args: (shellPath) => ['-e', shellPath] },
    { command: 'gnome-terminal', args: (shellPath) => ['--', shellPath] },
    { command: 'konsole', args: (shellPath) => ['-e', shellPath] },
    { command: 'xfce4-terminal', args: (shellPath) => ['--command', shellPath] },
  ];
}

export function executableOnPath(command: string, pathValue = process.env.PATH ?? ''): string | null {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, command);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}

/** Select the first installed adapter in the required desktop order. */
export function selectLinuxTerminal(pathValue = process.env.PATH ?? ''):
  | { executable: string; adapter: LinuxTerminalAdapter }
  | null {
  for (const adapter of linuxTerminalAdapters()) {
    const executable = executableOnPath(adapter.command, pathValue);
    if (executable) return { executable, adapter };
  }
  return null;
}
