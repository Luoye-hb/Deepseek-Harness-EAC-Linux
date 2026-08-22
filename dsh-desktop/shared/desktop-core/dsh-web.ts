/**
 * Shell-neutral dsh web lifecycle.
 *
 * This module owns only child-process startup and loopback readiness. It does
 * not import Electron or Tauri. The desktop-host and the Electron fallback can
 * adapt its handle into their own lifecycle/state machines.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import type {
  ChildProcess,
  ChildProcessByStdio,
} from 'node:child_process';
import type { Readable } from 'node:stream';

type DshWebProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface DshWebStartOptions {
  readonly nodePath: string;
  readonly dshBin: string;
  readonly profile: string;
  readonly cwd: string;
  readonly host?: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly extraArgs?: readonly string[];
  readonly bootTimeoutMs?: number;
  readonly httpTimeoutMs?: number;
  readonly logPath?: string;
  readonly onLog?: (stream: 'stdout' | 'stderr', text: string) => void;
  readonly useSystemCa?: boolean;
}

export interface DshWebHandle {
  readonly process: DshWebProcess;
  readonly url: string;
  stop(): Promise<void>;
}

const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
const DEFAULT_HTTP_TIMEOUT_MS = 3_000;

function appendLog(logPath: string | undefined, text: string): void {
  if (!logPath || !text) return;
  try {
    fs.appendFileSync(logPath, text);
  } catch {
    /* Diagnostics must not prevent service startup. */
  }
}

function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      if (response.statusCode === 200) {
        resolve();
      } else {
        reject(new Error(`dsh web HTTP readiness returned ${response.statusCode}`));
      }
    });
    request.once('timeout', () => {
      request.destroy(new Error('dsh web HTTP readiness timed out'));
    });
    request.once('error', reject);
  });
}

function normalizeLoopbackUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`dsh web advertised an invalid URL: ${raw}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    parsed.username ||
    parsed.password ||
    parsed.port === '0'
  ) {
    throw new Error(`dsh web advertised a non-loopback URL: ${raw}`);
  }
  return parsed.toString();
}

function signalProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  killProcessGroup: boolean,
): void {
  if (killProcessGroup && process.platform !== 'win32' && child.pid) {
    try {
      // POSIX dsh children are detached process-group leaders. Reap the
      // complete group so plugin descendants cannot outlive the host.
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try {
          child.kill(signal);
          return;
        } catch {
          /* The child may have exited between the two attempts. */
        }
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* The child may have exited concurrently. */
  }
}

function processGroupExists(pid: number | undefined, expected: boolean): boolean {
  if (!expected || process.platform === 'win32' || !pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function stopProcess(child: ChildProcess, killProcessGroup: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve();
    };
    const waitForGroup = (): void => {
      if (!processGroupExists(child.pid, killProcessGroup)) {
        finish();
        return;
      }
      if (forceTimer || hardTimer) return;
      forceTimer = setTimeout(() => {
        forceTimer = null;
        if (processGroupExists(child.pid, killProcessGroup)) {
          signalProcess(child, 'SIGKILL', killProcessGroup);
        }
        hardTimer = setTimeout(finish, 1_000);
      }, 5_000);
    };
    child.once('close', waitForGroup);
    signalProcess(child, 'SIGTERM', killProcessGroup);
    forceTimer = setTimeout(() => {
      forceTimer = null;
      if (processGroupExists(child.pid, killProcessGroup)) {
        signalProcess(child, 'SIGKILL', killProcessGroup);
      }
      hardTimer = setTimeout(finish, 1_000);
    }, 5_000);
  });
}

/** Spawn dsh web and return only after its advertised URL returns HTTP 200. */
export async function startDshWeb(options: DshWebStartOptions): Promise<DshWebHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const args = [
    ...(options.useSystemCa === false ? [] : ['--use-system-ca']),
    options.dshBin,
    '--profile',
    options.profile,
    '--host',
    host,
    '--port',
    String(port),
    ...(options.extraArgs ?? []),
  ];
  const childEnv = { ...process.env, ...options.env };
  // Tauri's Rust fence owns the host process group. Keeping DSH in that group
  // lets the fence reclaim it after a host crash; Electron retains its own
  // detached DSH group because its fallback client has no Rust fence.
  const detached = process.platform !== 'win32' && childEnv.DSH_DESKTOP !== '1';
  const child = spawn(options.nodePath, args, {
    cwd: options.cwd,
    env: childEnv,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as DshWebProcess;

  let stdout = '';
  let settled = false;
  let bootTimer: NodeJS.Timeout | null = null;
  let resolveReady: ((handle: DshWebHandle) => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;

  const ready = new Promise<DshWebHandle>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finishError = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (bootTimer) clearTimeout(bootTimer);
    // A caller commonly removes its temporary runtime immediately after a
    // failed start. Wait for the child to release Windows file handles first.
    void stopProcess(child, detached).finally(() => rejectReady?.(error));
  };
  const finishReady = (url: string): void => {
    if (settled) return;
    settled = true;
    if (bootTimer) clearTimeout(bootTimer);
    const handle: DshWebHandle = {
      process: child,
      url,
      stop: () => stopProcess(child, detached),
    };
    resolveReady?.(handle);
  };
  const onOutput = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    appendLog(options.logPath, text);
    options.onLog?.(stream, text);
    if (stream !== 'stdout' || settled) return;
    stdout += text;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      const match = /dsh web:\s+(https?:\/\/\S+)/.exec(line);
      if (!match?.[1]) continue;
      let url: string;
      try {
        url = normalizeLoopbackUrl(match[1]);
      } catch (error) {
        finishError(error as Error);
        return;
      }
      void waitForHttpOk(url, httpTimeoutMs).then(
        () => finishReady(url),
        (error: unknown) => finishError(error as Error),
      );
      return;
    }
  };

  child.stdout.on('data', (chunk: Buffer) => onOutput('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => onOutput('stderr', chunk));
  child.once('error', (error) => finishError(error));
  child.once('close', (code, signal) => {
    if (!settled) {
      finishError(new Error(`dsh web exited before readiness (code=${code}, signal=${signal})`));
    }
  });
  bootTimer = setTimeout(() => {
    finishError(new Error(`dsh web readiness timed out after ${bootTimeoutMs}ms`));
    void stopProcess(child, detached);
  }, bootTimeoutMs);
  bootTimer.unref();

  return ready;
}
