#!/usr/bin/env node
'use strict';

// glibc 基线检查（docs/support-matrix.md）——全仓库唯一的 GLIBC 基线判定实现。
// after-pack.js 的 node-pty 审计、CI 的产物复核（.github/workflows/
// build-arch-pacman.yml）和归档审计脚本（scripts/audit-linux-package.sh）
// 都从这里取阈值与扫描逻辑；调整基线只改这一个文件。
//
// 基线 GLIBC_2.34 = Debian 12 编译基线的实测最高引用（2026-08 Debian 事故
// 后的结论），覆盖支持矩阵定义的 2025-01~2026-08 发布窗口并兼容仍在维护的
// 旧 LTS。node-pty 是唯一在安装现场编译的原生载荷，是主要审计对象。
//
// 用法：node scripts/check-glibc.cjs [--baseline <minor>] <文件> [文件...]
//   --baseline  允许的最高 GLIBC 次版本号（默认 34，即 GLIBC_2.34）
// 退出码：0 = 全部通过（或跳过）；1 = 有文件超标或检查失败；2 = 用法错误。

const { spawnSync } = require('node:child_process');

const DEFAULT_BASELINE = [2, 34];

// objdump -T 列出动态符号表；取所有 GLIBC_x.y[z] 引用中的最高版本。
// 与 afterPack 原实现（及既有测试）保持一致的 fail-open 语义：objdump
// 不可用或执行失败时返回 null（跳过检查），由调用方决定如何呈现。
function maxGlibcRef(file) {
  const r = spawnSync('objdump', ['-T', file], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const versions = (r.stdout.match(/GLIBC_(\d+\.\d+(?:\.\d+)?)/g) || [])
    .map((s) => s.slice('GLIBC_'.length).split('.').map(Number));
  if (!versions.length) return null;
  versions.sort(compareVersion);
  return versions[versions.length - 1];
}

function compareVersion(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// 返回 { ok, skipped, message }，不抛错，方便 afterPack 与测试聚合调用。
function checkFile(file, baseline = DEFAULT_BASELINE) {
  const max = maxGlibcRef(file);
  if (max === null) return { ok: true, skipped: true, message: file + '：无法执行 objdump 或无 GLIBC 符号引用，跳过检查' };
  if (compareVersion(max, baseline) > 0) {
    return { ok: false, skipped: false, message: file + ' 要求 GLIBC_' + max.join('.') + '，超过基线 GLIBC_' + baseline.join('.') };
  }
  return { ok: true, skipped: false, message: file + '：GLIBC_' + max.join('.') + ' ≤ GLIBC_' + baseline.join('.') };
}

function main(argv) {
  let baseline = DEFAULT_BASELINE;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline') {
      const minor = Number(argv[++i]);
      if (!Number.isInteger(minor) || minor < 0) {
        console.error('无效的 --baseline 值: ' + argv[i]);
        return 2;
      }
      baseline = [2, minor];
    } else {
      files.push(argv[i]);
    }
  }
  if (!files.length) {
    console.error('用法: node scripts/check-glibc.cjs [--baseline <minor>] <文件> [文件...]');
    return 2;
  }
  let bad = 0;
  for (const f of files) {
    const r = checkFile(f, baseline);
    console.log((r.skipped ? 'SKIP: ' : r.ok ? 'OK: ' : 'ERROR: ') + r.message);
    if (!r.ok) bad++;
  }
  return bad ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { DEFAULT_BASELINE, maxGlibcRef, checkFile, compareVersion, main };
