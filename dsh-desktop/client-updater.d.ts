/**
 * client-updater.d.ts — legacy `client-updater.js` 的最小类型垫片
 * （lib/tray.ts 的 repoUrls 消费）。迁 TS（Task 6）后删除。
 */

/** 解析后的仓库地址对（github/gitee，owner/repo 形式）。 */
export interface RepoPair {
  github: string;
  gitee: string;
}

/** 从环境/默认值解析 GitHub/Gitee 仓库对。 */
export declare function resolveRepos(repos?: unknown): RepoPair;
