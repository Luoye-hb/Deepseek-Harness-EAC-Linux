/**
 * session-watcher.d.ts — legacy `session-watcher.js` 的最小类型垫片。
 *
 * 仅声明 lib 层（当前是 lib/paths.ts 的 fileRoots）消费的 scanZstdFrames；
 * main.js / session-encoding-heal 等既有 JS 使用方不受影响。
 * 待 session-watcher.js 迁 TS 后删除。
 */

/** 单个 zstd 帧在 buffer 内的 [start, end) 字节区间。 */
export interface ZstdFrame {
  start: number;
  end: number;
}

/** zstd 帧扫描结果：frames 按出现顺序排列。 */
export interface ZstdScanResult {
  frames: ZstdFrame[];
}

/** 扫描 buffer 中的 zstd 魔数（0x28 B5 2F FD）帧边界。 */
export declare function scanZstdFrames(buf: Buffer): ZstdScanResult;

/** 会话文件监听器（lib/boot.ts 装配；watch sessions/*.jsonl.zstd 的回合结束）。 */
export declare class SessionWatcher {
  constructor(opts: {
    sessionsDir: string;
    log(tag: string, msg: string): void;
    onTurnEnd(info: { sessionId: string; title?: string; body?: string }): void;
  });
  start(): void;
  stop(): void;
}
