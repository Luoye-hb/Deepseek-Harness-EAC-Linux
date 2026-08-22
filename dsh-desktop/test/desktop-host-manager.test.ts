import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { state } from '../lib/state.js';
import {
  startDesktopHost,
  stopDesktopHost,
} from '../lib/desktop-host.js';

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

test('Electron fallback host manager starts and gracefully shuts down the RPC path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-manager-'));
  try {
    const url = await startDesktopHost({
      nodePath: process.execPath,
      dshBin: fakeDshScript(dir),
      profile: 'web-desktop',
      cwd: dir,
      useSystemCa: false,
      bootTimeoutMs: 2_000,
      httpTimeoutMs: 500,
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(state.serverProc);
    assert.equal(state.webUrl, url);
  } finally {
    await stopDesktopHost();
    assert.equal(state.serverProc, null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
