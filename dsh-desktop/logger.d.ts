/**
 * logger.d.ts — legacy `logger.js`（pino 结构化日志）的最小类型垫片。
 *
 * 仅声明 lib/log.ts 消费的结构化级别方法；诊断 zip / 轮转 / 脱敏等
 * 其余 API 仍由 main.js（JS）直接使用，不需要在此声明。
 * 待 logger.js 迁 TS（Task 6.2）后删除。
 */

/** 结构化日志条目的附加字段（tag 为日志 subsystem 标签）。 */
export interface LogFields {
  tag: string;
  [key: string]: unknown;
}

export declare function info(msg: string, fields?: LogFields): void;
export declare function warn(msg: string, fields?: LogFields): void;
export declare function debug(msg: string, fields?: LogFields): void;
export declare function error(msg: string, fields?: LogFields): void;

/** 日志系统初始化（boot 最早调用；失败不影响 desktop.log 通道）。 */
export declare function init(opts: {
  logsDir: string;
  level: string;
  appVersion: string;
  env: string;
}): void;

/** 退出前 flush（结构化缓冲 + rotation stream 收尾）。 */
export declare function close(): void;

/** 一键导出诊断 zip（logs + configs + updater meta + 备份 manifest）。 */
export declare function buildDiagnosticsZip(opts: {
  logsDir: string;
  userDataDir: string;
  dshHome: string;
}): Promise<string>;
