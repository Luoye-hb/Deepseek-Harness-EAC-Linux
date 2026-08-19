/**
 * client-updater.d.ts — legacy `client-updater.js` 最小类型垫片
 * （lib/update-flow.ts 消费）。迁 TS（Task 6）后删除。
 */

/** 传给 client-updater 各 API 的上下文（即 lib/proc.ts 的 updCtx()）。 */
export interface ClientUpdCtx {
  userDataDir: string;
  nodeExe(): string;
  npmCli(): string;
  log(tag: string, msg: string): void;
}

/** 规范化后的 release 描述。 */
export interface NormalizedRelease {
  version: string;
  isNewer: boolean;
  source: string;
  body?: string;
  assets: { name: string; url: string; size: number; sha256?: string }[];
  [key: string]: unknown;
}

/** applyUpdate 的目录/版本参数。 */
export interface ApplyUpdateOpts {
  userDataDir: string;
  dshHome: string;
  installDir: string;
  profileDir: string;
  currentVersion: string;
  newVersion: string;
  nodeExe: string;
}

/** 下载进度回调元参。 */
export interface DownloadCallbacks {
  fallbacks?: unknown;
  onSourceChange?(source: string, idx: number, urls: string[]): void;
  onProgress(received: number, total: number): void;
}

/** 从默认仓库对解析 GitHub/Gitee slug。 */
export declare function resolveRepos(repos?: unknown): { github: string; gitee: string };

/** 检查最新客户端 release（无更新时 isNewer=false）。 */
export declare function checkLatest(
  ctx: ClientUpdCtx, currentVersion: string,
): Promise<NormalizedRelease>;

/** 其余发布源的同版本 release（备用下载链）。 */
export declare function releaseFallbacks(
  ctx: ClientUpdCtx, release: NormalizedRelease,
): Promise<unknown>;

/** 下载 release 主资产（支持断点续传与源切换）。 */
export declare function downloadRelease(
  ctx: ClientUpdCtx, release: NormalizedRelease, callbacks: DownloadCallbacks,
): Promise<{ filePath: string; size: number }>;

/** 派生分离的更新脚本进程并接管退出（调用后应用应尽快 exit）。 */
export declare function applyUpdate(
  ctx: ClientUpdCtx, pending: unknown, opts: ApplyUpdateOpts,
): void;
