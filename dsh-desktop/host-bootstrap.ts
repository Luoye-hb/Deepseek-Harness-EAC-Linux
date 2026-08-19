/**
 * host-bootstrap.ts — Extension Host 进程入口（VNext Phase 2，Task 10.2）。
 *
 * 运行形态：每个启用的 SDK 插件一个独立 Node 子进程（内置 node.exe 拉起
 * 本文件的编译产物 host-bootstrap.js），经 Win32 Job Object 围栏（见
 * lib/extension-host/job-fence.ts）与 Supervisor 隔离。
 *
 * 协议（长度前缀帧 JSON-RPC，见 lib/extension-host/rpc.ts）：
 *   1. Supervisor → req `init`（插件 id/入口/数据目录/权限）—— **本进程在
 *      收到 init 之前不加载任何插件代码**，这是混合围栏（Node spawn + Rust
 *      assign）的安全前提：插件代码不可能在围栏外执行；
 *   2. Supervisor → req `ping`（心跳，超时即被判死）；
 *   3. Supervisor → req `invoke`（工具调用，调用级超时由 RPC 层执行）；
 *   4. Host → notify `log`（插件结构化日志，Supervisor 转发落盘）。
 *
 * 权限门（deny-by-default，spec F1.2）：ctx 上未授权的能力**直接不存在**
 * （undefined），而非运行时报错。诚实边界（spec §11）：权限门约束的是 SDK
 * API 面（协作边界），不是对恶意代码的硬沙箱——硬边界是进程围栏（插件
 * 只能搞死自己的 Host，动不了核心与 Core Profile）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { RpcPeer } from './lib/extension-host/rpc.js';
import type { HostInitParams, HostInvokeParams, HostLogParams, PingParams } from './shared/protocol.js';

// ---------------------------------------------------------------------------
// 工具注册表（插件 activate 期间填充）
// ---------------------------------------------------------------------------

type ToolHandler = (args: unknown) => Promise<unknown> | unknown;
const tools = new Map<string, ToolHandler>();

// ---------------------------------------------------------------------------
// 权限门：路径围栏
// ---------------------------------------------------------------------------

/** 路径是否落在任一白名单根内（含自身；防 ../ 逃逸）。 */
function withinRoots(p: string, roots: readonly string[]): boolean {
  const norm = path.resolve(p);
  return roots.some((r) => {
    const root = path.resolve(r);
    return norm === root || norm.startsWith(root + path.sep);
  });
}

/** 授权目录白名单下的受控 fs 面（缺省能力 = undefined = 不可见）。 */
function scopedFs(roots: readonly string[]) {
  const guard = (p: string): string => {
    if (!withinRoots(p, roots)) throw new Error(`fs 越权：${p} 不在授权目录内`);
    return p;
  };
  return {
    readFile: (p: string): string => fs.readFileSync(guard(p), 'utf8'),
    readFileSync: (p: string): string => fs.readFileSync(guard(p), 'utf8'),
    writeFile: (p: string, data: string): void => {
      fs.mkdirSync(path.dirname(guard(p)), { recursive: true });
      fs.writeFileSync(guard(p), data);
    },
    writeFileSync: (p: string, data: string): void => {
      fs.mkdirSync(path.dirname(guard(p)), { recursive: true });
      fs.writeFileSync(guard(p), data);
    },
    readdir: (p: string): string[] => fs.readdirSync(guard(p)),
    mkdir: (p: string): void => {
      fs.mkdirSync(guard(p), { recursive: true });
    },
    stat: (p: string): fs.Stats => fs.statSync(guard(p)),
    unlink: (p: string): void => fs.rmSync(guard(p), { force: true }),
  };
}

/** 域名白名单下的受控 fetch（'*' = 任意主机；其余精确匹配 hostname）。 */
function scopedFetch(allow: readonly string[]) {
  return async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: string }> => {
    const u = new URL(url);
    const allowed = allow.includes('*') || allow.includes(u.hostname);
    if (!allowed) throw new Error(`net 越权：${u.hostname} 不在授权主机白名单内`);
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status, body: await res.text() };
  };
}

// ---------------------------------------------------------------------------
// SDK ctx（插件拿到的全部能力面）
// ---------------------------------------------------------------------------

/** 权限可见性拼装：未授权字段一概不出现（编译期/书写期即不可见）。 */
function buildCtx(params: HostInitParams) {
  const { permissions, dataDir } = params;
  const ctx: Record<string, unknown> = {
    id: params.pluginId,
    dataDir,
    /** 插件日志：notify 回 Supervisor 统一落盘（不占插件自身 IO）。 */
    log: (level: HostLogParams['level'], msg: string): void => {
      peer.notify('log', { level, msg: String(msg).slice(0, 2000) } satisfies HostLogParams);
    },
    registerTool: (name: string, handler: ToolHandler): void => {
      tools.set(String(name), handler);
    },
  };
  if (permissions.net !== undefined && permissions.net.length > 0) {
    ctx.net = { fetch: scopedFetch(permissions.net) };
  }
  if (permissions.fs !== undefined && permissions.fs.length > 0) {
    // 数据目录始终可见（插件私有命名空间），叠加声明的额外目录。
    ctx.fs = scopedFs([dataDir, ...permissions.fs]);
  } else {
    ctx.fs = scopedFs([dataDir]);
  }
  if (permissions.shell === true) {
    ctx.shell = {
      exec: (cmd: string, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          exec(String(cmd), { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            const code = typeof err?.code === 'number' ? err.code : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          });
        }),
    };
  }
  if (permissions.env === true) {
    ctx.env = { get: (k: string): string | undefined => process.env[k] };
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// RPC 端点
// ---------------------------------------------------------------------------

const peer = new RpcPeer({
  write: process.stdout,
  onClosed: (reason) => {
    // Supervisor 断开（退出/被杀）：host 无存活意义，立即退（Job 也会兜底）。
    process.stderr.write(`[host-bootstrap] supervisor 断开: ${reason}\n`);
    process.exit(0);
  },
});

// 心跳：原样回带发出时间戳（Supervisor 侧测 RTT / 超时判死）
peer.handle('ping', (params) => {
  const p = params as PingParams;
  return { t: p.t, now: Date.now() };
});

// 工具调用：不存在/异常 → error 响应（调用级超时由 Supervisor 侧 RPC 执行）
peer.handle('invoke', async (params) => {
  const p = params as HostInvokeParams;
  const h = tools.get(p.tool);
  if (!h) throw new Error(`unknown tool: ${p.tool}`);
  return await h(p.args);
});

// init：加载插件并激活（在此之前本进程不执行任何插件代码）
peer.handle('init', async (params) => {
  const p = params as HostInitParams;
  const mod = require(p.entryPath) as { activate?: (ctx: Record<string, unknown>) => unknown } | ((ctx: Record<string, unknown>) => unknown);
  const activate = typeof mod === 'function' ? mod : mod.activate;
  if (typeof activate !== 'function') {
    throw new Error(`插件入口无 activate 导出: ${p.entryPath}`);
  }
  await activate(buildCtx(p));
  return { tools: [...tools.keys()] };
});

process.stdin.on('data', (chunk: Buffer) => peer.feed(chunk));

// 插件把宿主搞崩：留最后一行 stderr 给诊断，快速退出（Supervisor 感知 exit）
process.on('uncaughtException', (err) => {
  process.stderr.write(`[host-bootstrap] uncaughtException: ${String(err && err.stack || err)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[host-bootstrap] unhandledRejection: ${String(reason)}\n`);
  process.exit(1);
});
