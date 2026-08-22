'use strict';

// 获取官方 Node v24.19.0 可执行文件到 vendor/node。
//
// 原因：打包后的应用用真实 node.exe 拉起 dsh CLI，保证预编译原生模块
// （sharp / node-pty / koffi …）的 Node ABI 与编译时一致。Electron 内嵌
// Node 的 ABI 不同会拒绝加载它们；针对 Electron 重编译又会破坏纯 Node
// 场景。随包分发安装时使用的同一个 node.exe 是零配置的 ABI 匹配方案。
//
// 用法（必须在系统 Node 下运行，不能在 Electron 内）：
//   npm run fetch-node

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const NODE_VERSION = 'v24.19.0';
const DIST_BASE = `https://nodejs.org/dist/${NODE_VERSION}`;
const runtimeDir = path.resolve(__dirname, '..', 'vendor', 'node');
const executable = process.platform === 'win32' ? 'node.exe' : 'node';
const dest = path.join(runtimeDir, executable);

function get(url: string, destination?: string, redirects = 0): Promise<Buffer | void> {
  if (redirects > 5) return Promise.reject(new Error(`too many redirects: ${url}`));
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const location = response.headers.location;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        resolve(get(new URL(location, url).toString(), destination, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GET ${url} failed: HTTP ${response.statusCode}`));
        return;
      }
      if (!destination) {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
        return;
      }
      const out = fs.createWriteStream(destination);
      response.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchOfficialRuntime(): Promise<void> {
  if (process.arch !== 'x64' || (process.platform !== 'win32' && process.platform !== 'linux')) {
    throw new Error(`unsupported runtime target: ${process.platform}-${process.arch} (Windows/Linux x64 only)`);
  }
  const target = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
  const extension = process.platform === 'win32' ? 'zip' : 'tar.xz';
  const archiveName = `node-${NODE_VERSION}-${target}.${extension}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-runtime-'));
  const archive = path.join(tempDir, archiveName);
  try {
    const sums = String(await get(`${DIST_BASE}/SHASUMS256.txt`));
    const escaped = archiveName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expected = new RegExp(`^([a-f0-9]{64})\\s+${escaped}$`, 'mi').exec(sums)?.[1];
    if (!expected) throw new Error(`official checksum missing for ${archiveName}`);
    await get(`${DIST_BASE}/${archiveName}`, archive);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (actual !== expected.toLowerCase()) throw new Error(`SHA-256 mismatch for ${archiveName}`);
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '& { param([string]$archive, [string]$destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }',
        archive,
        tempDir,
      ], { stdio: 'inherit' });
    } else {
      execFileSync('tar', ['-xJf', archive, '-C', tempDir], { stdio: 'inherit' });
    }
    const source = process.platform === 'win32'
      ? path.join(tempDir, `node-${NODE_VERSION}-win-x64`, 'node.exe')
      : path.join(tempDir, `node-${NODE_VERSION}-linux-x64`, 'bin', 'node');
    if (!fs.existsSync(source)) throw new Error(`official archive did not contain ${source}`);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.rmSync(path.join(runtimeDir, process.platform === 'win32' ? 'node' : 'node.exe'), { force: true });
    fs.copyFileSync(source, dest);
    if (process.platform === 'linux') fs.chmodSync(dest, 0o755);
    const actualVersion = execFileSync(dest, ['--version'], { encoding: 'utf8' }).trim();
    if (actualVersion !== NODE_VERSION) throw new Error(`runtime version mismatch: ${actualVersion}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await fetchOfficialRuntime();
  console.log(`Downloaded and verified official Node ${NODE_VERSION} / ${process.platform}-x64`);
  console.log(`    -> ${dest}`);
}

main().catch((error: unknown) => {
  console.error(`fetch-node failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
