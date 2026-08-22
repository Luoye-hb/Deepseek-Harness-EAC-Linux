'use strict';

// 把随系统 Node 分发的 npm CLI 复制进 vendor/npm。打包应用经 vendored
// node.exe 使用它来检查并安装官方 @deepseek-ai/dsh 更新 —— npm 会按
// registry 发布意图精确解析依赖树、处理平台相关的 optional deps、并尊重
// 用户的 .npmrc（镜像、代理）。
//
// 用法（必须在系统 Node 下运行）：
//   npm run fetch-npm

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const candidates = [
  path.resolve(__dirname, '..', 'vendor', 'node', 'lib', 'node_modules', 'npm'),
  path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
  path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'),
];
const src = candidates.find((p) => fs.existsSync(path.join(p, 'bin', 'npm-cli.js'))) ?? candidates[0]!;
const dest = path.resolve(__dirname, '..', 'vendor', 'npm');

if (!fs.existsSync(path.join(src, 'bin', 'npm-cli.js'))) {
  console.error('找不到随 Node 分发的 npm，已检查：\n' + candidates.join('\n'));
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const npmPackagePath = path.join(dest, 'package.json');
const npmPackage = JSON.parse(fs.readFileSync(npmPackagePath, 'utf8')) as Record<string, unknown>;
delete npmPackage.devDependencies;
delete npmPackage.workspaces;
fs.writeFileSync(npmPackagePath, JSON.stringify(npmPackage, null, 2) + '\n', 'utf8');
const npmCommand = process.env.npm_execpath
  ? process.execPath
  : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];
execFileSync(npmCommand, [
  ...npmArgs,
  'install',
  '--prefix', dest,
  '--omit=dev',
  '--ignore-scripts',
  '--no-package-lock',
  '--no-audit',
  '--no-fund',
  '--workspaces=false',
], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
const version = (JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`已复制 npm@${version}`);
console.log(`    ${src}`);
console.log(` -> ${dest}`);
