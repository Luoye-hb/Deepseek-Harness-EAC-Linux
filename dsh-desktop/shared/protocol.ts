/**
 * shared/protocol.ts — VNext 插件隔离架构的「单点类型源」。
 *
 * 职责：RPC 消息、扩展注册表、SDK API 面、权限模型等跨边界结构的类型定义。
 * 主进程（Supervisor）、Extension Host（host-bootstrap）、Core Bridge 与 preload
 * 全部从这里导入类型，保证三方的协议视图编译期一致。
 *
 * 注意：本文件遵守 erasableSyntaxOnly（仅类型/接口，无运行时语句），
 * 因此既可被 tsc 编译，也可被 Node ≥ 23.6 的 type-stripping 直接执行。
 */

/** 扩展（插件）类型：隔离 SDK 插件 / Legacy Cordis 直注入插件。 */
export type ExtensionKind = 'isolated' | 'legacy';

/** 插件来源。 */
export type ExtensionSource = 'builtin' | 'market' | 'manual';

/** 风险等级（恢复中心展示 + 注册表归档）。 */
export type ExtensionRisk = 'trusted-core' | 'legacy-cordis' | 'isolated-sdk';

/** 故障状态机（架构文档 §8）。 */
export type ExtensionState =
  | 'installed'
  | 'disabled'
  | 'starting'
  | 'running'
  | 'retrying'
  | 'failed'
  | 'quarantined'
  | 'uninstalled';

/** 插件能力权限声明（deny-by-default：未声明即不可见）。 */
export interface ExtensionPermissions {
  /** 允许访问的网络主机白名单（如 ['api.github.com']）。 */
  readonly net?: readonly string[];
  /** 允许读写的目录白名单（插件 data 目录始终可见）。 */
  readonly fs?: readonly string[];
  /** 是否允许派生子进程（默认 false）。 */
  readonly shell?: boolean;
  /** 是否允许读取环境变量（默认 false）。 */
  readonly env?: boolean;
}

/** 注册表中单个插件条目的静态档案（动态字段见 ExtensionRuntimeState）。 */
export interface ExtensionRecord {
  readonly id: string;
  readonly version: string;
  readonly source: ExtensionSource;
  readonly risk: ExtensionRisk;
  readonly kind: ExtensionKind;
  /** 安装包内容 SHA-256（原子安装校验 + 完整性锁定）。 */
  readonly packageSha256: string;
  readonly installedAt: string;
  readonly permissions: ExtensionPermissions;
  /** 可回滚的历史版本（新版本在前）。 */
  readonly rollbackVersions: readonly { version: string; packageSha256: string }[];
}

/** 注册表中单个插件条目的动态状态。 */
export interface ExtensionRuntimeState {
  readonly state: ExtensionState;
  readonly enabled: boolean;
  /** 连续崩溃次数（成功运行达到稳定期后清零）。 */
  crashStreak: number;
  /** 最近一次错误摘要（恢复中心展示）。 */
  lastError?: string;
  readonly lastErrorAt?: string;
  readonly lastHealthyAt?: string;
  /** 退避重试的下次允许启动时间（ISO 时间戳）。 */
  nextRetryAt?: string;
}

/** 注册表整体结构（<DSH_HOME>/extensions/registry.json）。 */
export interface ExtensionRegistry {
  readonly schemaVersion: 1;
  readonly plugins: Record<string, ExtensionRecord & ExtensionRuntimeState>;
}

/** 状态机转移结果。 */
export interface TransitionResult {
  readonly from: ExtensionState;
  readonly to: ExtensionState;
  /** 是否产生了需要落盘的变化。 */
  readonly changed: boolean;
  /** 转移原因（写事故记录）。 */
  readonly reason?: string;
}
