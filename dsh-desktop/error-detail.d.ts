/**
 * error-detail.d.ts — legacy `error-detail.js` 的最小类型垫片（lib/server.ts 消费）。
 * 待 error-detail.js 迁 TS 后删除。
 */

/** 从日志目录拼装人类可读的错误详情（供「服务已停止」对话框展示/复制）。 */
export declare function buildErrorDetail(
  err: unknown,
  logsDir: string,
  logFiles: string[],
): string;
