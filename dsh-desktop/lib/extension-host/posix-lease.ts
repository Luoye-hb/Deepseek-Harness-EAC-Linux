import * as fs from 'node:fs';
import * as path from 'node:path';
import { terminateProcessTree } from '../process-tree.js';

export interface PosixHostLease {
  pluginId: string;
  pid: number;
  pgid: number;
  procStartTime: string;
  hostBootstrapPath: string;
  createdAt: string;
}

export interface LeaseContext {
  pluginId: string;
  leaseDir: string;
  executablePath: string;
  hostBootstrapPath: string;
  onMismatch(detail: string): void;
}

export interface ProcIdentity {
  pid: number;
  pgid: number;
  procStartTime: string;
  executablePath: string;
  argv: string[];
}

function safePluginId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function leasePath(ctx: Pick<LeaseContext, 'pluginId' | 'leaseDir'>): string {
  return path.join(ctx.leaseDir, `${safePluginId(ctx.pluginId)}.json`);
}

function realpathOrResolve(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Read the Linux identity fields needed to reject stale or forged leases. */
export function readProcIdentity(pid: number): ProcIdentity | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const pgid = Number(fields[2]); // field 5; the slice starts at field 3
    const procStartTime = fields[19]; // field 22
    if (!Number.isSafeInteger(pgid) || pgid <= 0 || !procStartTime) return null;
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const executablePath = fs.readlinkSync(`/proc/${pid}/exe`);
    return { pid, pgid, procStartTime, executablePath, argv };
  } catch {
    return null;
  }
}

function parseLease(raw: unknown): PosixHostLease | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<PosixHostLease>;
  if (
    typeof v.pluginId !== 'string'
    || !Number.isSafeInteger(v.pid) || (v.pid ?? 0) <= 0
    || !Number.isSafeInteger(v.pgid) || (v.pgid ?? 0) <= 0
    || typeof v.procStartTime !== 'string' || !v.procStartTime
    || typeof v.hostBootstrapPath !== 'string' || !path.isAbsolute(v.hostBootstrapPath)
    || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt))
  ) return null;
  return v as PosixHostLease;
}

function mismatch(ctx: LeaseContext, detail: string): void {
  ctx.onMismatch(`Linux Fence 租约拒绝清理: ${detail}`);
}

function identityMismatch(ctx: LeaseContext, lease: PosixHostLease, proc: ProcIdentity): string | null {
  if (lease.pluginId !== ctx.pluginId) return `pluginId 不匹配 (${lease.pluginId})`;
  if (lease.pid !== lease.pgid) return `租约 PID/PGID 不一致 (${lease.pid}/${lease.pgid})`;
  if (proc.pid !== lease.pid || proc.pgid !== lease.pgid) {
    return `PID/PGID 不匹配 (lease=${lease.pid}/${lease.pgid}, proc=${proc.pid}/${proc.pgid})`;
  }
  if (proc.procStartTime !== lease.procStartTime) return 'proc start time 不匹配，疑似 PID 复用';
  const expectedBootstrap = realpathOrResolve(ctx.hostBootstrapPath);
  if (realpathOrResolve(lease.hostBootstrapPath) !== expectedBootstrap) return '租约 bootstrap 路径不匹配';
  const argvBootstrap = proc.argv.slice(1).some((arg) => realpathOrResolve(arg) === expectedBootstrap);
  if (!argvBootstrap) return '进程命令行不包含预期 host-bootstrap 入口';
  if (realpathOrResolve(proc.executablePath) !== realpathOrResolve(ctx.executablePath)) {
    return '进程可执行文件与捆绑 Node 不匹配';
  }
  return null;
}

/** Reclaim a prior valid host group before launching a replacement. */
export async function reclaimPosixLease(ctx: LeaseContext): Promise<'none' | 'cleaned' | 'rejected'> {
  if (process.platform !== 'linux') return 'none';
  const file = leasePath(ctx);
  if (!fs.existsSync(file)) return 'none';
  let lease: PosixHostLease | null = null;
  try {
    lease = parseLease(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // Report below while preserving the file as evidence.
  }
  if (!lease) {
    mismatch(ctx, `租约格式无效 (${file})`);
    return 'rejected';
  }
  const proc = readProcIdentity(lease.pid);
  if (!proc) {
    fs.rmSync(file, { force: true });
    return 'cleaned';
  }
  const reason = identityMismatch(ctx, lease, proc);
  if (reason) {
    mismatch(ctx, `${reason} (${file})`);
    return 'rejected';
  }
  const gone = await terminateProcessTree(lease.pgid);
  if (!gone) {
    mismatch(ctx, `进程组 ${lease.pgid} 在有界清理后仍存活 (${file})`);
    return 'rejected';
  }
  fs.rmSync(file, { force: true });
  return 'cleaned';
}

/** Persist a 0600 lease only after the detached host identity is observable. */
export function writePosixLease(ctx: LeaseContext, pid: number): PosixHostLease {
  const proc = readProcIdentity(pid);
  if (!proc) throw new Error(`无法读取 Host /proc 身份 (pid=${pid})`);
  if (proc.pgid !== pid) throw new Error(`Host 未建立独立进程组 (pid=${pid}, pgid=${proc.pgid})`);
  const expectedBootstrap = realpathOrResolve(ctx.hostBootstrapPath);
  if (!proc.argv.slice(1).some((arg) => realpathOrResolve(arg) === expectedBootstrap)) {
    throw new Error('Host 命令行缺少预期 host-bootstrap 入口');
  }
  if (realpathOrResolve(proc.executablePath) !== realpathOrResolve(ctx.executablePath)) {
    throw new Error('Host 未使用指定的捆绑 Node 运行时');
  }
  const lease: PosixHostLease = {
    pluginId: ctx.pluginId,
    pid,
    pgid: proc.pgid,
    procStartTime: proc.procStartTime,
    hostBootstrapPath: path.resolve(ctx.hostBootstrapPath),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(ctx.leaseDir, { recursive: true, mode: 0o700 });
  const file = leasePath(ctx);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(lease, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return lease;
}

export function removePosixLease(ctx: LeaseContext): void {
  fs.rmSync(leasePath(ctx), { force: true });
}
