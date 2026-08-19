/**
 * lib/plugin-copy.ts — 插件包复制家族（Task 5.2 自 main.js 提取）。
 *
 * 拷贝一个插件包目录到 profile node_modules（按包名 scope 落位，幂等）。
 * V4 关键优化：先比对「源 vs 目标」内容戳记（版本+文件数+字节数），一致则
 * 跳过 —— 旧逻辑每次启动全量重拷（dsh-pet 15MB、dsh-dafeiyu ~58MB 资产，
 * 拖慢启动）。戳记文件放在包目录内（.eac-copy-stamp.json），pnpm 重写
 * node_modules 时随目录消失，天然触发重建。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 随插件/皮肤包一起拷贝的许可与出处文件（存在才拷贝）。 */
export const EXTRA_PACKAGE_FILES = [
  'LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md',
  'README.md', 'README.zh.md', 'THIRD-PARTY-NOTICES.md',
];

const COPY_STAMP = '.eac-copy-stamp.json';

/** 安全读 JSON（损坏/缺失返回 null）。 */
export function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// 与 copyPluginPackage 的拷贝清单保持一致（多算/漏算都会导致每次都重拷，
// 只会浪费不会出错）。
export function pluginCopyEntries(src: string): string[] {
  const out: string[] = [];
  const copyFile = (rel: string): void => {
    const sf = path.join(src, rel);
    if (!fs.existsSync(sf) || fs.statSync(sf).isDirectory()) return;
    out.push(rel);
  };
  const copyDir = (rel: string): void => {
    const sd = path.join(src, rel);
    if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) return;
    for (const entry of fs.readdirSync(sd, { withFileTypes: true })) {
      const sub = rel + '/' + entry.name;
      if (entry.isDirectory()) copyDir(sub);
      else copyFile(sub);
    }
  };
  for (const f of ['package.json', 'skin.json', ...EXTRA_PACKAGE_FILES]) copyFile(f);
  for (const f of ['index.js', 'client.js', 'recall-inject.js', 'cordis.patch.yml']) copyFile(f);
  for (const d of ['lib', 'preview', 'vendor', 'node_modules', 'data', 'assets', 'runtime', 'src', 'client']) copyDir(d);
  return out;
}

/** 计算源目录内容戳记（版本+文件数+字节数的 JSON 串；失败 null）。 */
export function pluginStampOf(src: string): string | null {
  try {
    const pkg = readJsonFile(path.join(src, 'package.json')) ?? {};
    let files = 0;
    let bytes = 0;
    for (const rel of pluginCopyEntries(src)) {
      files += 1;
      try {
        bytes += fs.statSync(path.join(src, rel)).size;
      } catch {
        /* 单文件 stat 失败忽略 */
      }
    }
    return JSON.stringify({ v: String(pkg.version ?? ''), f: files, b: bytes });
  } catch {
    return null;
  }
}

/** 拷贝插件包到 profile node_modules（内容戳记一致则跳过；幂等）。 */
export function copyPluginPackage(profileDirP: string, src: string, name: string): void {
  const destRoot = path.join(profileDirP, 'node_modules', ...name.split('/'));
  const stampFile = path.join(destRoot, COPY_STAMP);
  const want = pluginStampOf(src);
  try {
    if (want && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === want) {
      return; // 内容未变：跳过全量重拷
    }
  } catch {
    /* 比对失败按需重拷 */
  }
  fs.mkdirSync(path.dirname(destRoot), { recursive: true });
  const copyFile = (rel: string): void => {
    const sf = path.join(src, rel);
    if (!fs.existsSync(sf) || fs.statSync(sf).isDirectory()) return;
    const df = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(df), { recursive: true });
    fs.copyFileSync(sf, df);
  };
  const copyDir = (rel: string): void => {
    const sd = path.join(src, rel);
    if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) return;
    for (const entry of fs.readdirSync(sd, { withFileTypes: true })) {
      const sub = rel + '/' + entry.name;
      if (entry.isDirectory()) copyDir(sub);
      else copyFile(sub);
    }
  };
  // lib 整目录随包（配套插件可能有 logic.js 等额外模块，按清单拷会漏文件
  // 导致 dsh web 启动时 ERR_MODULE_NOT_FOUND）。
  for (const f of ['package.json', 'skin.json', ...EXTRA_PACKAGE_FILES]) copyFile(f);
  // 社区插件（soul-md / tdai-memory / tool-vision）入口在包根目录而非
  // lib/，vendor/ 是其内置依赖，同样必须随包分发。
  for (const f of ['index.js', 'client.js', 'recall-inject.js', 'cordis.patch.yml']) copyFile(f);
  copyDir('lib');
  copyDir('preview');
  copyDir('vendor');
  // 内置插件自带的嵌套 node_modules（vendored 运行时依赖）：放在包内部，
  // pnpm 重写 profile node_modules 顶层时不会波及，插件保持自包含。
  copyDir('node_modules');
  // dsh-webui-market 的离线目录快照（官网不可达时的兜底数据）。
  copyDir('data');
  // dsh-pet / dsh-dafeiyu 等带运行时静态资源的插件（宠物动画 webp/png 帧、
  // PyInstaller helper 等）。
  copyDir('assets');
  copyDir('runtime');
  // dsh-dafeiyu 的入口在 src/（lib/ 只有 client 半边）；dsh-offpeak 的
  // client 半边在 client/（包 exports 映射）。
  copyDir('src');
  copyDir('client');
  if (want) {
    try {
      fs.mkdirSync(destRoot, { recursive: true });
      fs.writeFileSync(stampFile, want);
    } catch {
      /* 戳记写失败不影响功能 */
    }
  }
}
