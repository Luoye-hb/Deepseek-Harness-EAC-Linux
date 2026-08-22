import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  startDshWeb,
  type DshWebHandle,
} from '../shared/desktop-core/dsh-web.ts';

function fakeDshScript(dir: string): string {
  const file = path.join(dir, 'fake-dsh.cjs');
  fs.writeFileSync(
    file,
    [
      "const http = require('node:http');",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });",
      "server.listen(port, '127.0.0.1', () => {",
      "  const actual = server.address().port;",
      "  process.stdout.write(`dsh web: http://127.0.0.1:${actual}/\\n`);",
      "});",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join('\n'),
  );
  return file;
}

test('dsh web core waits for the advertised URL to return HTTP 200', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-core-'));
  let handle: DshWebHandle | null = null;
  try {
    handle = await startDshWeb({
      nodePath: process.execPath,
      dshBin: fakeDshScript(dir),
      profile: 'web-desktop',
      cwd: dir,
      useSystemCa: false,
      bootTimeoutMs: 2_000,
      httpTimeoutMs: 500,
    });
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(handle.url);
    assert.equal(response.status, 200);
  } finally {
    await handle?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dsh web core reports child exit before readiness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-core-'));
  const script = path.join(dir, 'exit.cjs');
  fs.writeFileSync(script, 'process.exit(7);\n');
  try {
    await assert.rejects(
      startDshWeb({
        nodePath: process.execPath,
        dshBin: script,
        profile: 'web-desktop',
        cwd: dir,
        useSystemCa: false,
        bootTimeoutMs: 1_000,
      }),
      /exited before readiness/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dsh web core rejects a non-loopback advertised URL and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-core-'));
  const script = path.join(dir, 'bad-url.cjs');
  fs.writeFileSync(
    script,
    [
      "process.stdout.write('dsh web: http://192.0.2.10:43123/\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  try {
    await assert.rejects(
      startDshWeb({
        nodePath: process.execPath,
        dshBin: script,
        profile: 'web-desktop',
        cwd: dir,
        useSystemCa: false,
        bootTimeoutMs: 1_000,
      }),
      /non-loopback URL/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
