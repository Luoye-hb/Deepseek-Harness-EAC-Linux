import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const processTree = require(path.join(root, 'lib', 'process-tree.js'));
const leases = require(path.join(root, 'lib', 'extension-host', 'posix-lease.js'));
const fences = require(path.join(root, 'lib', 'extension-host', 'job-fence.js'));
const LINUX = process.platform === 'linux';

function fixture(dir: string, name: string, source = 'setInterval(() => {}, 1000);'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

function context(dir: string, bootstrap: string, mismatches: string[] = []) {
  return {
    pluginId: 'lease-test',
    leaseDir: path.join(dir, 'leases'),
    executablePath: process.execPath,
    hostBootstrapPath: bootstrap,
    onMismatch: (detail: string) => mismatches.push(detail),
  };
}

function start(bootstrap: string) {
  return spawn(process.execPath, [bootstrap], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function cleanup(pid: number | undefined): Promise<void> {
  if (pid) await processTree.terminateProcessTree(pid, { graceMs: 100, hardMs: 2_000 });
}

async function waitUntil(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pidAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return close >= 0 && stat.slice(close + 2).split(/\s+/)[0] !== 'Z';
  } catch {
    return false;
  }
}

test('process-tree: POSIX cleanup terminates a detached root and its descendant', { skip: !LINUX }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-tree-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const grandchild = fixture(dir, 'grandchild.cjs');
  const script = fixture(dir, 'tree.cjs', `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    fs.writeFileSync(process.argv[2], String(child.pid));
    setInterval(() => {}, 1000);
  `);
  const rootChild = spawn(process.execPath, [script, pidFile], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitUntil(() => fs.existsSync(pidFile), 3_000);
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(await processTree.terminateProcessTree(rootChild.pid, { graceMs: 100, hardMs: 2_000 }), true);
    await waitUntil(() => !processTree.processTreeAlive(rootChild.pid));
    assert.equal(pidAlive(grandchildPid), false);
  } finally {
    await cleanup(rootChild.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux lease: writes the required identity fields with mode 0600', { skip: !LINUX }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-mode-'));
  const bootstrap = fixture(dir, 'host.cjs');
  const child = start(bootstrap);
  const ctx = context(dir, bootstrap);
  try {
    const lease = leases.writePosixLease(ctx, child.pid);
    assert.deepEqual(Object.keys(lease).sort(), [
      'createdAt', 'hostBootstrapPath', 'pgid', 'pid', 'pluginId', 'procStartTime',
    ]);
    assert.equal(lease.pid, lease.pgid);
    assert.equal(fs.statSync(leases.leasePath(ctx)).mode & 0o777, 0o600);
  } finally {
    await cleanup(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const mutation of ['forged-plugin', 'reused-pid', 'bootstrap-command'] as const) {
  test(`Linux lease: ${mutation} mismatch records an incident and never signals`, { skip: !LINUX }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-reject-'));
    const actualBootstrap = fixture(dir, 'actual.cjs');
    const expectedBootstrap = mutation === 'bootstrap-command'
      ? fixture(dir, 'expected.cjs')
      : actualBootstrap;
    const child = start(actualBootstrap);
    const mismatches: string[] = [];
    const ctx = context(dir, expectedBootstrap, mismatches);
    try {
      const identity = leases.readProcIdentity(child.pid);
      assert.ok(identity);
      const lease = {
        pluginId: mutation === 'forged-plugin' ? 'forged' : ctx.pluginId,
        pid: child.pid,
        pgid: child.pid,
        procStartTime: mutation === 'reused-pid' ? `${identity.procStartTime}9` : identity.procStartTime,
        hostBootstrapPath: expectedBootstrap,
        createdAt: new Date().toISOString(),
      };
      fs.mkdirSync(ctx.leaseDir, { recursive: true });
      fs.writeFileSync(leases.leasePath(ctx), JSON.stringify(lease), { mode: 0o600 });
      assert.equal(await leases.reclaimPosixLease(ctx), 'rejected');
      assert.equal(processTree.processTreeAlive(child.pid), true);
      assert.equal(mismatches.length, 1);
      assert.equal(fs.existsSync(leases.leasePath(ctx)), true, 'rejected lease remains as evidence');
    } finally {
      await cleanup(child.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('Linux lease: a valid stale lease reclaims the old process group', { skip: !LINUX }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-stale-'));
  const bootstrap = fixture(dir, 'host.cjs');
  const child = start(bootstrap);
  const ctx = context(dir, bootstrap);
  try {
    leases.writePosixLease(ctx, child.pid);
    assert.equal(await leases.reclaimPosixLease(ctx), 'cleaned');
    assert.equal(processTree.processTreeAlive(child.pid), false);
    assert.equal(fs.existsSync(leases.leasePath(ctx)), false);
  } finally {
    await cleanup(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux Fence: rejected lease blocks launch and preserves evidence', { skip: !LINUX }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-block-'));
  const bootstrap = fixture(dir, 'host.cjs');
  const unrelated = start(bootstrap);
  const ctx = context(dir, bootstrap);
  const fence = fences.createFence({
    pluginId: ctx.pluginId,
    leaseDir: ctx.leaseDir,
    hostBootstrapPath: bootstrap,
    onLeaseMismatch: ctx.onMismatch,
  });
  try {
    const identity = leases.readProcIdentity(unrelated.pid);
    assert.ok(identity);
    fs.mkdirSync(ctx.leaseDir, { recursive: true });
    fs.writeFileSync(leases.leasePath(ctx), JSON.stringify({
      pluginId: ctx.pluginId,
      pid: unrelated.pid,
      pgid: unrelated.pid,
      procStartTime: `${identity.procStartTime}9`,
      hostBootstrapPath: bootstrap,
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    await assert.rejects(fence.launch(process.execPath, [bootstrap]), /拒绝覆盖/);
    assert.equal(processTree.processTreeAlive(unrelated.pid), true);
    assert.equal(fs.existsSync(leases.leasePath(ctx)), true);
  } finally {
    fence.dispose();
    await cleanup(unrelated.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux Fence: normal Host exit reclaims its surviving grandchild before deleting lease', { skip: !LINUX }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-exit-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const grandchild = fixture(dir, 'grandchild.cjs');
  const bootstrap = fixture(dir, 'host.cjs', `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    fs.writeFileSync(process.argv[2], String(child.pid));
    setTimeout(() => process.exit(0), 100);
  `);
  const ctx = context(dir, bootstrap);
  const fence = fences.createFence({
    pluginId: ctx.pluginId,
    leaseDir: ctx.leaseDir,
    hostBootstrapPath: bootstrap,
    onLeaseMismatch: ctx.onMismatch,
  });
  let handle: any;
  try {
    handle = await fence.launch(process.execPath, [bootstrap, pidFile]);
    await waitUntil(() => fs.existsSync(pidFile), 3_000);
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise<void>((resolve) => handle.onExit(() => resolve()));
    assert.equal(processTree.processTreeAlive(handle.pid), false);
    assert.equal(pidAlive(grandchildPid), false);
    assert.equal(fs.existsSync(leases.leasePath(ctx)), false);
  } finally {
    if (handle) await handle.kill();
    fence.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Fence capability matrix states the limits of all three modes', () => {
  const win = fences.capabilitiesForFenceMode('win32-job');
  const posix = fences.capabilitiesForFenceMode('posix-process-group');
  const fallback = fences.capabilitiesForFenceMode('taskkill-fallback');
  assert.deepEqual([win.mode, posix.mode, fallback.mode], [
    'win32-job', 'posix-process-group', 'taskkill-fallback',
  ]);
  assert.equal(win.hardResourceLimits, true);
  assert.equal(win.killOnSupervisorExit, true);
  assert.equal(posix.hardResourceLimits, false);
  assert.equal(posix.killOnSupervisorExit, false);
  assert.match(posix.limitation, /SIGKILL/);
  assert.equal(fallback.hardResourceLimits, false);
  assert.equal(fallback.killOnSupervisorExit, false);
});
