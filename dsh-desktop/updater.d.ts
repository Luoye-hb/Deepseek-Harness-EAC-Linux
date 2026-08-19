/**
 * updater.d.ts — legacy `updater.js` 的最小类型垫片（过渡期产物）。
 *
 * 背景：lib/*.ts（TypeScript）需要引用尚未迁移 TS 的根目录 `updater.js`。
 * 提供「按需、强类型」的声明而非 allowJs 直接吃 JS（后者会让 tsc 把整个
 * updater.js 拉进编译程序并原地产出重排版 emit，污染工作区）。
 *
 * 约定：仅声明 lib 层实际消费的符号；main.js（仍是 JS）不受影响。
 * 待 Task 7 将 updater.js 迁 TS 后本文件删除，类型并入真实实现。
 */

/** 传给 updater 各 API 的上下文（见 lib/proc.ts 的 updCtx()）。 */
export interface UpdCtx {
  /** Electron userData 目录。 */
  userDataDir: string;
  /** 内置 node.exe 路径解析器。 */
  nodeExe(): string;
  /** 内置 npm-cli.js 路径解析器。 */
  npmCli(): string;
  /** 统一日志通道（lib/log.ts）。 */
  log(tag: string, msg: string): void;
}

/** settings.yaml 的形状（仅声明桌面壳读写的字段，其余视为未知扩展）。 */
export interface DshSettings {
  /** 与官方 web profile 共享（旧兼容模式）。 */
  shareWebProfile?: boolean;
  /** 关闭主窗时最小化到托盘（默认 true）。 */
  closeToTray?: boolean;
  /** 快捷方式维护策略：'never' | 'auto'。 */
  shortcutPolicy?: string;
  /** 其余字段（dsh 侧维护）原样透传。 */
  [key: string]: unknown;
}

export declare function loadSettings(ctx: UpdCtx): DshSettings;
export declare function saveSettings(ctx: UpdCtx, settings: DshSettings): void;
/** semver 风格比较：a<b 负数 / 相等 0 / a>b 正数。 */
export declare function compareVersions(a: string, b: string): number;
/** 用户已批准安装的 agent 更新 overlay 的 bin 路径（无则 null）。 */
export declare function overlayBinPath(ctx: UpdCtx): string | null;
/** 当前生效的 dsh 版本号（内置或 overlay）。 */
export declare function activeVersion(ctx: UpdCtx): string | null;
/** overlay 里记录的版本（用于判断「内置/已更新」来源）。 */
export declare function overlayVersion(ctx: UpdCtx): string | null;
/** settings.json 路径（userData 目录）。 */
export declare function settingsPath(ctx: UpdCtx): string;
/** npm 检查最新版本；失败抛错。 */
export declare function checkLatest(ctx: UpdCtx): Promise<string>;
/** agent 更新的进度事件（npm 阶段流）。 */
export interface AgentProgressEvent {
  stage: 'fetch' | 'install' | 'done' | 'mirror' | string;
  count?: number;
  elapsed?: string;
  registry?: string;
}
/** 下载并安装 agent 更新 overlay。 */
export declare function applyUpdate(
  ctx: UpdCtx, version: string,
  opts?: { onProgress?: (ev: AgentProgressEvent) => void },
): Promise<unknown>;
/** 上一版本信息（更新保障②的回退目标；无则 null）。 */
export declare function previousAgentInfo(ctx: UpdCtx): { version: string } | null;
/** 回退到上一版本 overlay。 */
export declare function rollbackToPrevious(ctx: UpdCtx): unknown;
/** 回退到内置版本（清掉 overlay）。 */
export declare function rollback(ctx: UpdCtx): unknown;
/** 中止正在进行的 npm 子进程（更新/回退期间应用退出时调用）。 */
export declare function abort(): void;
