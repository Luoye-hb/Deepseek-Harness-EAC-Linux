import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  DesktopHostFrameDecoder,
  encodeDesktopHostFrame,
} from '../desktop-host/rpc.ts';

const root = path.join(import.meta.dirname, '..');
const entry = path.join(root, 'desktop-host', 'main.js');

interface WireMessage {
  kind: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  event?: string;
  payload?: unknown;
}

function request(
  child: ReturnType<typeof spawn>,
  id: string,
  method: string,
  params: unknown = null,
): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const decoder = new DesktopHostFrameDecoder();
    const cleanup = (): void => {
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === 'res' && message.id === id) {
          cleanup();
          resolve(message as WireMessage);
          return;
        }
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`desktop-host exited before response (code=${code}, signal=${signal})`));
    };
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
    child.stdin?.write(encodeDesktopHostFrame({
      kind: 'req',
      version: 1,
      id,
      method,
      params,
    }));
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForPidGone(pid: number): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} remained alive`);
}

test('desktop-host main speaks framed stdio RPC and shuts down cleanly', async () => {
  assert.equal(fs.existsSync(entry), true, 'run npm run build before this test');
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const ping = await request(child, 'ping-1', 'host:ping');
    assert.equal(ping.ok, true);
    assert.equal(typeof (ping.result as { pid: number }).pid, 'number');
    assert.match(String((ping.result as { node: string }).node), /^v\d+\./);

    const shutdown = await request(child, 'shutdown-1', 'host:shutdown');
    assert.deepEqual(shutdown.result, { ok: true });
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    assert.equal(code, 0);
    assert.equal(stderr, '');
  } finally {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  }
});

test('desktop-host main starts dsh web through the same RPC boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-main-'));
  const fakeDsh = path.join(dir, 'fake-dsh.cjs');
  fs.writeFileSync(
    fakeDsh,
    [
      "const http = require('node:http');",
      "const requested = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });",
      "server.listen(requested, '127.0.0.1', () => {",
      "  process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/\\n`);",
      "});",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join('\n'),
  );
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const started = await request(child, 'start-1', 'dsh:start', {
      nodePath: process.execPath,
      dshBin: fakeDsh,
      profile: 'web-desktop',
      cwd: dir,
      env: {
        DSH_HOME: dir,
        DSH_DESKTOP_USERDATA: dir,
      },
      assetsDir: path.join(root, 'assets', 'plugins'),
    });
    assert.equal(started.ok, true);
    assert.match(String((started.result as { url: string }).url), /^http:\/\/127\.0\.0\.1:\d+\/$/);
    // dsh:start creates web-desktop/node_modules while synchronizing bundled
    // plugins. The first-run decision must already be frozen at that point.
    const onboardingNeeded = await request(child, 'onboard-needs-1', 'onboard:needs');
    assert.deepEqual(onboardingNeeded.result, { needed: true });
    const balancePackage = path.join(
      dir,
      'profiles',
      'web-desktop',
      'node_modules',
      '@deepseek-ai',
      'dsh-balance',
    );
    assert.equal(fs.existsSync(path.join(balancePackage, 'lib', 'client.js')), true);
    assert.match(
      fs.readFileSync(path.join(dir, 'profiles', 'web-desktop', 'cordis.patch.yml'), 'utf8'),
      /- id: balance\n      name: '@deepseek-ai\/dsh-balance'/,
    );

    const updated = await request(child, 'balance-set-1', 'balance:prices:set', {
      model: 'deepseek-v4-pro',
      prices: {
        peak: { cacheMiss: 10, cacheHit: 1, output: 20 },
        offpeak: { cacheMiss: 5, cacheHit: 0.5, output: 10 },
      },
    });
    assert.deepEqual(updated.result, { ok: true });
    const prices = await request(child, 'balance-get-1', 'balance:prices:get', {
      model: 'deepseek-v4-pro',
    });
    assert.deepEqual(
      (prices.result as { current: unknown }).current,
      {
        peak: { cacheMiss: 10, cacheHit: 1, output: 20 },
        offpeak: { cacheMiss: 5, cacheHit: 0.5, output: 10 },
      },
    );

    const menu = await request(child, 'menu-state-1', 'menu:state');
    assert.equal((menu.result as { notifyOnTurnEnd: boolean }).notifyOnTurnEnd, true);
    const toggled = await request(child, 'menu-action-1', 'menu:action', {
      action: 'toggle-notify',
    });
    assert.equal(
      (toggled.result as { notifyOnTurnEnd: boolean }).notifyOnTurnEnd,
      false,
    );
    const recovery = await request(child, 'recovery-state-1', 'recovery:state');
    assert.equal((recovery.result as { state: { dsh: { running: boolean } } }).state.dsh.running, true);
    const reloaded = await request(child, 'recovery-reload-1', 'recovery:reload');
    assert.equal((reloaded.result as { reused: boolean }).reused, true);

    const onboarding = await request(child, 'onboard-list-1', 'onboard:list', {
      mode: 'first',
    });
    assert.equal((onboarding.result as { mode: string }).mode, 'first');
    assert.equal((onboarding.result as { current: unknown }).current, null);
    assert.ok(Array.isArray((onboarding.result as { catalog: unknown[] }).catalog));
    const cancelled = await request(child, 'onboard-close-1', 'onboard:close', {
      mode: 'first',
    });
    assert.deepEqual(cancelled.result, { ok: true, cancelled: true });
    const onboardingDone = await request(child, 'onboard-needs-2', 'onboard:needs');
    assert.deepEqual(onboardingDone.result, { needed: false });
    const pageError = await request(child, 'page-error-1', 'diagnostic:page-error', {
      message: 'test page error',
    });
    assert.deepEqual(pageError.result, { ok: true });
    const recoveryAction = await request(
      child,
      'recovery-action-1',
      'recovery:action',
      { action: 'status' },
    );
    assert.equal((recoveryAction.result as { ok: boolean }).ok, true);
    assert.ok(Array.isArray((recoveryAction.result as { plugins: unknown[] }).plugins));

    const stopped = await request(child, 'stop-1', 'dsh:stop');
    assert.deepEqual(stopped.result, { ok: true, stopped: true });
    const shutdown = await request(child, 'shutdown-1', 'host:shutdown');
    assert.deepEqual(shutdown.result, { ok: true });
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  } finally {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop-host SIGTERM stops the detached dsh process group before exiting', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-sigterm-'));
  const fakeDsh = path.join(dir, 'fake-dsh.cjs');
  const lease = path.join(dir, 'desktop-host.lease.json');
  fs.writeFileSync(lease, '{}');
  fs.writeFileSync(
    fakeDsh,
    [
      "const http = require('node:http');",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });",
      "server.listen(port, '127.0.0.1', () => process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/\\n`));",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join('\n'),
  );
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, DSH_DESKTOP_LEASE: lease },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const started = await request(child, 'sigterm-start-1', 'dsh:start', {
      nodePath: process.execPath,
      dshBin: fakeDsh,
      profile: 'web-desktop',
      cwd: dir,
      env: { DSH_HOME: dir, DSH_DESKTOP_USERDATA: dir },
      useSystemCa: false,
      bootTimeoutMs: 2_000,
      httpTimeoutMs: 500,
    });
    const dshPid = (started.result as { pid?: number }).pid;
    assert.equal(typeof dshPid, 'number');
    child.kill('SIGTERM');
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null });
    await waitForPidGone(dshPid as number);
    assert.equal(fs.existsSync(lease), false);
  } finally {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
