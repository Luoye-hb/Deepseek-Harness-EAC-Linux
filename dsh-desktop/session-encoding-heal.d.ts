/**
 * session-encoding-heal.d.ts — legacy `session-encoding-heal.js` 的最小类型垫片
 * （lib/server.ts 的 bootRescuePreRetry 消费）。迁 TS 后删除。
 */

/** 会话编码冲突自愈的归档结果（被归档的文件绝对路径列表）。 */
export interface HealEncodingOpts {
  /** 期望统一到的压缩格式（桌面端固定 'zstd'）。 */
  compression: string;
  /** 统一日志通道。 */
  log(tag: string, msg: string): void;
}

/** 判断错误文本是否为 encodingMismatch（会话 zstd/明文并存，Issue #77）。 */
export declare function isEncodingMismatch(text: string): boolean;

/** 归档相反格式的遗留会话日志文件（数据无损），返回归档路径列表。 */
export declare function healSessionEncodingConflicts(
  sessionsDir: string,
  opts: HealEncodingOpts,
): string[];
