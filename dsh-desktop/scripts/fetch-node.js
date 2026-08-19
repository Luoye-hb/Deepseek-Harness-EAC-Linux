'use strict';

// Linux packages must use the official low-glibc Node runtime, not whatever
// happens to be installed on the build machine. This keeps the Node ABI and
// the published support baseline reproducible.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NODE_VERSION = 'v24.19.0';
const DIST_BASE = `https://nodejs.org/dist/${NODE_VERSION}`;
const executable = process.platform === 'win32' ? 'node.exe' : 'node';
const dest = path.resolve(__dirname, '..', 'vendor', 'node', executable);

function get(url, destination = null, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error(`too many redirects: ${url}`));
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        return resolve(get(new URL(location, url).toString(), destination, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`GET ${url} failed: HTTP ${response.statusCode}`));
      }
      if (!destination) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
        return;
      }
      const out = fs.createWriteStream(destination);
      response.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function fetchLinuxRuntime() {
  const archiveName = `node-${NODE_VERSION}-linux-x64.tar.xz`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-runtime-'));
  const archive = path.join(tempDir, archiveName);
  try {
    const sums = (await get(`${DIST_BASE}/SHASUMS256.txt`)).toString('utf8');
    const expected = new RegExp(`^([a-f0-9]{64})\\s+${archiveName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, 'mi').exec(sums)?.[1];
    if (!expected) throw new Error(`official checksum missing for ${archiveName}`);
    await get(`${DIST_BASE}/${archiveName}`, archive);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (actual !== expected.toLowerCase()) throw new Error(`SHA-256 mismatch for ${archiveName}`);
    execFileSync('tar', ['-xJf', archive, '-C', tempDir], { stdio: 'inherit' });
    const source = path.join(tempDir, `node-${NODE_VERSION}-linux-x64`, 'bin', 'node');
    if (!fs.existsSync(source)) throw new Error(`official archive did not contain ${source}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, 0o755);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform === 'linux' && process.arch === 'x64') {
    await fetchLinuxRuntime();
    console.log(`Downloaded official Node ${NODE_VERSION} / linux-x64`);
  } else {
    // Preserve the established Windows development flow. Linux releases never
    // take this branch, so their ABI and glibc baseline stay pinned above.
    if (!/node(\.exe)?$/i.test(path.basename(process.execPath))) {
      throw new Error('fetch-node must run under system Node, not Electron');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(process.execPath, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    console.log(`Copied host Node ${process.version} for ${process.platform}-${process.arch}`);
  }
  console.log(`    -> ${dest}`);
}

main().catch((error) => {
  console.error(`fetch-node failed: ${error.message}`);
  process.exitCode = 1;
});
