/**
 * desktop-host/main.ts — bundled Node sidecar entry.
 *
 * The process speaks only framed RPC on stdin/stdout. All diagnostics go to
 * stderr. The host is intentionally independent from Electron and Tauri.
 */

import { DesktopHostRpc } from './rpc.js';
import { DesktopHostService } from './service.js';
import { unlinkSync } from 'node:fs';

let peer: DesktopHostRpc | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<{ readonly ok: true }> | null = null;
let exitRequested = false;
const service = new DesktopHostService({
  notify: (event, payload) => peer?.notify(event, payload),
});

function shutdownService(): Promise<{ readonly ok: true }> {
  shutdownPromise ??= service.shutdown();
  return shutdownPromise;
}

function removeLease(): void {
  const lease = process.env.DSH_DESKTOP_LEASE?.trim();
  if (!lease) return;
  try {
    unlinkSync(lease);
  } catch {
    /* The supervisor may already have removed the lease. */
  }
}

function exitAfterShutdown(code: number): void {
  if (exitRequested) return;
  exitRequested = true;
  void shutdownService()
    .catch((error) => {
      process.stderr.write(`[desktop-host] shutdown failed: ${String(error)}\n`);
    })
    .finally(() => {
      removeLease();
      process.exit(code);
    });
}

peer = new DesktopHostRpc({
  write: process.stdout,
  onClosed: (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[desktop-host] RPC closed: ${reason}\n`);
    exitAfterShutdown(1);
  },
});
service.register(peer);

peer.handle('host:shutdown', async () => {
  if (shuttingDown) return { ok: true };
  shuttingDown = true;
  const result = await shutdownService();
  setImmediate(() => exitAfterShutdown(0));
  return result;
});

process.stdin.on('data', (chunk: Buffer) => peer?.feed(chunk));
process.stdin.on('end', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  exitAfterShutdown(0);
});
process.stdin.resume();

process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  exitAfterShutdown(0);
});

process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  exitAfterShutdown(0);
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`[desktop-host] uncaughtException: ${String(error.stack || error)}\n`);
  peer?.close('uncaught-exception');
  shuttingDown = true;
  exitAfterShutdown(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[desktop-host] unhandledRejection: ${String(reason)}\n`);
  peer?.close('unhandled-rejection');
  shuttingDown = true;
  exitAfterShutdown(1);
});
