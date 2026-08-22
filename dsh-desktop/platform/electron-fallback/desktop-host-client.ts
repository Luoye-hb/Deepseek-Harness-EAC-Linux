/**
 * Electron-side client for the bundled desktop-host.
 *
 * This is an adapter only: it owns the child process and framed transport,
 * while the host remains independent from Electron and Tauri.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { DesktopHostRpc } from '../../desktop-host/rpc.js';
import type {
  DesktopHostPingResult,
  DshStartParams,
  DshStartResult,
  DshStatusResult,
  DshStopResult,
} from '../../shared/contract/desktop-host.js';

export interface ElectronDesktopHostClientOptions {
  readonly nodePath: string;
  readonly entryPath: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onNotify?: (event: string, payload: unknown) => void;
  readonly onStderr?: (text: string) => void;
  readonly onClosed?: (reason: string) => void;
}

export class ElectronDesktopHostClient {
  readonly process: ChildProcessWithoutNullStreams;
  readonly rpc: DesktopHostRpc;

  private readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly onClosed: ((reason: string) => void) | undefined;

  constructor(options: ElectronDesktopHostClientOptions) {
    this.onClosed = options.onClosed;
    const child = spawn(options.nodePath, [options.entryPath], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    this.exit = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.rpc = new DesktopHostRpc({
      write: child.stdin,
      ...(options.onNotify ? { onNotify: options.onNotify } : {}),
      onClosed: (reason) => {
        this.onClosed?.(reason);
      },
    });
    child.stdout.on('data', (chunk: Buffer) => this.rpc.feed(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      options.onStderr?.(chunk.toString('utf8'));
    });
    child.once('error', (error) => {
      this.rpc.close(`host-error: ${error.message}`);
    });
    child.once('close', (code, signal) => {
      if (!this.rpc.isClosed()) {
        this.rpc.close(`host-exited: code=${code} signal=${signal}`);
      }
    });
  }

  ping(): Promise<DesktopHostPingResult> {
    return this.rpc.request<DesktopHostPingResult>('host:ping', null);
  }

  status(): Promise<DshStatusResult> {
    return this.rpc.request<DshStatusResult>('host:status', null);
  }

  start(params: DshStartParams): Promise<DshStartResult> {
    return this.rpc.request<DshStartResult>('dsh:start', params);
  }

  stop(): Promise<DshStopResult> {
    return this.rpc.request<DshStopResult>('dsh:stop', null);
  }

  async shutdown(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = this.exit;
    try {
      await this.rpc.request<{ readonly ok: true }>('host:shutdown', null);
    } finally {
      await exited;
    }
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exit;
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill(signal);
    }
  }
}
