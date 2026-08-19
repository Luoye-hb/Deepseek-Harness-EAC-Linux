/**
 * scripts/patch-session-manage.d.ts — legacy 垫片。迁 TS 后删除。
 * 返回应用的补丁处数（0 = 锚点不匹配，已跳过）。
 */
export declare function patchSessionManage(
  root: string, log: (m: string) => void,
): number;
