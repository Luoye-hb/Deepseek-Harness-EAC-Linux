import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { ElectronDesktopHostClient } from '../platform/electron-fallback/desktop-host-client.js';

const root = path.join(import.meta.dirname, '..');

function fakeDshScript(dir: string): string {
  const file = path.join(dir, 'fake-dsh.cjs');
  fs.writeFileSync(
    file,
    [
      "const http = require('node:http');",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });",
      "server.listen(port, '127.0.0.1', () => {",
      "  process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/\\n`);",
      "});",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join('\n'),
  );
  return file;
}

test('Electron fallback client drives desktop-host and receives lifecycle events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-client-'));
  const events: { event: string; payload: unknown }[] = [];
  let stderr = '';
  const client = new ElectronDesktopHostClient({
    nodePath: process.execPath,
    entryPath: path.join(root, 'desktop-host', 'main.js'),
    cwd: root,
    onNotify: (event, payload) => events.push({ event, payload }),
    onStderr: (text) => {
      stderr += text;
    },
  });
  try {
    const ping = await client.ping();
    assert.equal(typeof ping.pid, 'number');
    assert.match(ping.node, /^v\d+\./);

    const dshBin = fakeDshScript(dir);
    const started = await client.start({
      nodePath: process.execPath,
      dshBin,
      profile: 'web-desktop',
      cwd: dir,
      useSystemCa: false,
      bootTimeoutMs: 2_000,
      httpTimeoutMs: 500,
    });
    assert.equal(started.ok, true);
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal((await client.status()).running, true);

    const reused = await client.start({
      nodePath: process.execPath,
      dshBin,
      cwd: dir,
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.url, started.url);
    assert.ok(events.some((item) => item.event === 'dsh.ready'));

    const stopped = await client.stop();
    assert.deepEqual(stopped, { ok: true, stopped: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const exitEvent = events.find((item) => item.event === 'dsh.exit');
    assert.equal((exitEvent?.payload as { intentional?: boolean })?.intentional, true);
    assert.equal((await client.status()).running, false);

    await client.shutdown();
    const exit = await client.waitForExit();
    assert.equal(exit.code, 0);
    assert.equal(stderr, '');
  } finally {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Electron fallback reports an unexpected desktop-host exit', async () => {
  const reasons: string[] = [];
  const client = new ElectronDesktopHostClient({
    nodePath: process.execPath,
    entryPath: path.join(root, 'desktop-host', 'main.js'),
    cwd: root,
    onClosed: (reason) => reasons.push(reason),
  });
  try {
    await client.ping();
    client.kill('SIGKILL');
    const exit = await client.waitForExit();
    assert.equal(exit.signal, 'SIGKILL');
    assert.match(reasons.join('\n'), /host-exited/);
  } finally {
    client.kill();
  }
});

test('Electron fallback classifies an unexpected dsh exit as non-intentional', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-client-crash-'));
  const events: { event: string; payload: unknown }[] = [];
  const client = new ElectronDesktopHostClient({
    nodePath: process.execPath,
    entryPath: path.join(root, 'desktop-host', 'main.js'),
    cwd: root,
    onNotify: (event, payload) => events.push({ event, payload }),
  });
  try {
    await client.start({
      nodePath: process.execPath,
      dshBin: fakeDshScript(dir),
      profile: 'web-desktop',
      cwd: dir,
      useSystemCa: false,
      bootTimeoutMs: 2_000,
      httpTimeoutMs: 500,
    });
    const status = await client.status();
    assert.ok(status.pid);
    process.kill(status.pid!, 'SIGKILL');
    for (let i = 0; i < 50 && !events.some((item) => item.event === 'dsh.exit'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exitEvent = events.find((item) => item.event === 'dsh.exit');
    assert.equal((exitEvent?.payload as { intentional?: boolean })?.intentional, false);
    assert.equal((await client.status()).running, false);
    await client.shutdown();
  } finally {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
