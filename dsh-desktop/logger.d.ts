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
