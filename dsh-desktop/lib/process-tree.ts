import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

export interface TerminateTreeOptions {
  graceMs?: number;
  hardMs?: number;
  pollMs?: number;
}

const DEFAULT_GRACE_MS = 1_200;
const DEFAULT_HARD_MS = 4_000;
const DEFAULT_POLL_MS = 100;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** Check the process-group identity on POSIX, or the root PID on Windows. */
export function processTreeAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'linux') {
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
          const close = stat.lastIndexOf(')');
          if (close < 0) continue;
          const fields = stat.slice(close + 2).trim().split(/\s+/);
          if (Number(fields[2]) === pid && fields[0] !== 'Z') return true;
        } catch {
          /* Process exited while /proc was scanned. */
        }
      }
      return false;
    } catch {
      /* Fall through to kill(0) when procfs is unavailable. */
    }
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitForProcessTreeExit(
  pid: number,
  timeoutMs: number,
  pollMs = DEFAULT_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processTreeAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function taskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

/**
 * Terminate one complete child tree with a bounded graceful-to-force sequence.
 * POSIX callers must have spawned the root with `detached: true`, making pid the
 * process-group id. A failed group signal is never replaced with a single-PID
 * signal because that would silently leave descendants behind.
 */
export async function terminateProcessTree(
  pid: number,
  opts: TerminateTreeOptions = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const hardMs = opts.hardMs ?? DEFAULT_HARD_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  if (!processTreeAlive(pid)) return true;
  if (process.platform === 'win32') {
    await taskkill(pid, false);
    if (await waitForProcessTreeExit(pid, graceMs, pollMs)) return true;
    await taskkill(pid, true);
    return waitForProcessTreeExit(pid, hardMs, pollMs);
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    throw err;
  }
  if (await waitForProcessTreeExit(pid, graceMs, pollMs)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    throw err;
  }
  return waitForProcessTreeExit(pid, hardMs, pollMs);
}

export async function terminateChildProcessTree(
  child: ChildProcess | null,
  opts: TerminateTreeOptions = {},
): Promise<boolean> {
  return child?.pid ? terminateProcessTree(child.pid, opts) : true;
}

/** Start bounded cleanup without making the caller await it. */
export function requestProcessTreeTermination(
  child: ChildProcess | null,
  opts: TerminateTreeOptions = {},
  onError?: (err: unknown) => void,
): void {
  void terminateChildProcessTree(child, opts).catch((err) => onError?.(err));
}
