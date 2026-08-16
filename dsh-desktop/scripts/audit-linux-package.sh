#!/usr/bin/env bash
# Linux 安装包归档级终检（docs/support-matrix.md §4「自动审计」）。
#
# 背景（3.0.1 Arch 事故 / 2026-08 Debian 事故）：afterPack 审计只覆盖展开目录，
# 归档打包阶段仍可能丢文件或带入高 glibc 产物。本脚本在「最终安装包」层面复核：
#   1. node-pty 的 pty.node 真的在归档里（存在性）；
#   2. 捆绑 Node 存在，并能实际加载 pty.node（N-API 兼容 / 文件完整）；
#   3. 归档内全部原生载荷（*.node / *.so / 捆绑 node）的 glibc 引用 ≤ 2.34
#      基线（scripts/check-glibc.cjs，全仓库唯一的阈值来源）。
#
# 用法: audit-linux-package.sh <pkg> [pkg...]    # .pacman / .deb / .rpm / .AppImage
# 依赖: bsdtar(pacman) / dpkg-deb(deb) / rpm2cpio+cpio(rpm) / node / objdump
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <pkg.pacman|pkg.deb|pkg.rpm|pkg.AppImage> [pkg...]" >&2
  exit 2
fi

for pkg in "$@"; do
  [[ -f "$pkg" ]] || { echo "ERROR: 不是文件: $pkg" >&2; exit 1; }
done

extract_pkg() {
  local pkg="$1" dest="$2"
  case "${pkg,,}" in
    *.pacman)   bsdtar -xf "$pkg" -C "$dest" ;;
    *.deb)      dpkg-deb -x "$pkg" "$dest" ;;
    *.rpm)      (cd "$dest" && rpm2cpio "$pkg" | cpio -idm --quiet) ;;
    *.appimage) chmod +x "$pkg"; (cd "$dest" && "$pkg" --appimage-extract >/dev/null) ;;
    *)
      echo "ERROR: 不支持的包格式: $pkg（支持 .pacman / .deb / .rpm / .AppImage）" >&2
      exit 2 ;;
  esac
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for pkg in "$@"; do
  echo "==> 归档审计: $pkg"
  rm -rf "${tmp:?}"/*
  extract_pkg "$pkg" "$tmp"

  pty_file="$(find "$tmp" \( -path '*/node-pty/build/Release/pty.node' -o -path '*/node-pty/prebuilds/linux-x64/pty.node' \) -type f | head -n1)"
  if [[ -z "$pty_file" ]]; then
    echo "ERROR: $pkg 缺少 node-pty 原生模块 pty.node" >&2
    exit 1
  fi
  echo "OK: node-pty native module present ($pty_file)"

  node_bin="$(find "$tmp" -path '*/resources/node/node' -type f | head -n1)"
  if [[ -z "$node_bin" ]]; then
    echo "ERROR: $pkg 缺少捆绑 Node 运行时" >&2
    exit 1
  fi
  # 与 afterPack 审计一致：加载 node-pty 包入口（lib/index.js），而不是裸
  # pty.node——原生二进制只导出 fork/open/resize/process，spawn 由 JS 包装
  # 层提供（node-pty@1.1.0），裸加载会把好包误判为坏包。
  node_pty_root="$(dirname "$(dirname "$(dirname "$pty_file")")")"
  "$node_bin" -e "const pty = require(process.argv[1]); if (typeof pty.spawn !== 'function') throw new Error('node-pty API 异常'); console.log('OK: node-pty loadable @ ' + process.version)" "$node_pty_root"

  # 全部原生载荷的 glibc 基线扫描（阈值与逻辑统一在 check-glibc.cjs）。
  mapfile -t payloads < <(find "$tmp" -type f \( -name '*.node' -o -name '*.so' -o -path '*/resources/node/node' \) | sort)
  if [[ ${#payloads[@]} -gt 0 ]]; then
    node "$repo/scripts/check-glibc.cjs" "${payloads[@]}"
  fi
  echo "OK: $pkg 归档审计通过（${#payloads[@]} 个原生载荷已扫描）"
done
