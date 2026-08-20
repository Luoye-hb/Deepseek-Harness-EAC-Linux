#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required audit tool is unavailable: $1"
}

[[ $# -gt 0 ]] || { echo "usage: $0 <package> [package...]" >&2; exit 2; }
need objdump
need ldd
need file
need realpath

packages=()
for package in "$@"; do
  [[ -f "$package" ]] || fail "package is not a file: $package"
  packages+=("$(realpath "$package")")
done

audit_tmp="$(mktemp -d /tmp/dsh-package-audit.XXXXXX)"
trap 'rm -rf "$audit_tmp"' EXIT

extract_package() {
  local package="$1" destination="$2"
  case "${package,,}" in
    *.pacman)
      need bsdtar
      bsdtar -xf "$package" -C "$destination"
      [[ -s "$destination/.PKGINFO" ]] || fail "pacman metadata .PKGINFO is missing"
      grep -Eq '^arch = x86_64$' "$destination/.PKGINFO" || fail "pacman package is not x86_64"
      [[ -s "$destination/.MTREE" ]] || fail "pacman metadata .MTREE is missing"
      [[ -s "$destination/.INSTALL" ]] || fail "pacman metadata .INSTALL is missing"
      ;;
    *.deb)
      need dpkg-deb
      [[ "$(dpkg-deb -f "$package" Architecture)" == "amd64" ]] || fail "deb package is not amd64"
      [[ -n "$(dpkg-deb -f "$package" Package)" ]] || fail "deb Package metadata is missing"
      dpkg-deb -x "$package" "$destination"
      ;;
    *.rpm)
      need rpm
      need rpm2cpio
      need cpio
      local rpm_db="$audit_tmp/rpmdb"
      mkdir -p "$rpm_db"
      [[ "$(rpm --dbpath "$rpm_db" -qp --qf '%{ARCH}' "$package")" == "x86_64" ]] || fail "rpm package is not x86_64"
      [[ -n "$(rpm --dbpath "$rpm_db" -qp --qf '%{NAME}' "$package")" ]] || fail "rpm Name metadata is missing"
      (cd "$destination" && rpm2cpio "$package" | cpio -idm --quiet)
      ;;
    *.appimage)
      chmod +x "$package"
      (cd "$destination" && "$package" --appimage-extract >/dev/null)
      [[ -x "$destination/squashfs-root/AppRun" ]] || fail "AppImage AppRun is missing"
      ;;
    *)
      fail "unsupported package format: $package"
      ;;
  esac
}

one_file() {
  local label="$1" pattern="$2" root="$3"
  local result
  result="$(find "$root" -type f -path "$pattern" -print -quit)"
  [[ -n "$result" ]] || fail "$label is missing"
  printf '%s\n' "$result"
}

for package in "${packages[@]}"; do
  echo "==> auditing $package"
  extract_dir="$audit_tmp/extract"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  extract_package "$package" "$extract_dir"

  node_bin="$(one_file 'bundled Node' '*/resources/node/node' "$extract_dir")"
  npm_cli="$(one_file 'bundled npm CLI' '*/resources/npm/bin/npm-cli.js' "$extract_dir")"
  electron_bin="$(one_file 'Electron executable' '*/deepseek-harness-eac' "$extract_dir")"
  desktop_file="$(find "$extract_dir" -type f -name '*.desktop' -print -quit)"
  icon_file="$(find "$extract_dir" -type f -path '*/icons/*' -name '*.png' -print -quit)"
  [[ -n "$desktop_file" ]] || fail "desktop entry is missing"
  [[ -n "$icon_file" ]] || fail "desktop icon is missing"
  [[ -x "$node_bin" ]] || fail "bundled Node is not executable"
  [[ -x "$electron_bin" ]] || fail "Electron executable is not executable"
  if find "$extract_dir" -type f -path '*/native/supervisor/index.node' -print -quit | grep -q .; then
    fail "Linux package contains Windows supervisor"
  fi

  [[ "$("$node_bin" --version)" == 'v24.19.0' ]] || fail "bundled Node is not v24.19.0"
  "$node_bin" "$npm_cli" --version >/dev/null

  resources_dir="$(dirname "$(dirname "$(dirname "$npm_cli")")")"
  app_root="$resources_dir/app"
  node_pty_root="$app_root/node_modules/node-pty"
  [[ -d "$node_pty_root" ]] || fail "node-pty package is missing"
  "$node_bin" -e 'const pty=require(process.argv[1]);if(typeof pty.spawn!=="function")process.exit(2)' "$node_pty_root"
  "$node_bin" -e \
    'const root=process.argv[1];const sharp=require(root+"/node_modules/sharp");const koffi=require(root+"/node_modules/koffi");if(typeof sharp!=="function"||typeof koffi.load!=="function")process.exit(2)' \
    "$app_root"

  memory_root="$app_root/assets/plugins/dsh-tdai-memory"
  [[ -f "$memory_root/index.js" ]] || fail "dsh-tdai-memory entry is missing"
  "$node_bin" --input-type=module -e \
    'import {createRequire} from "node:module";const require=createRequire(import.meta.url);const root=process.argv[1];require(root+"/node_modules/@node-rs/jieba-linux-x64-gnu");require(root+"/node_modules/sqlite-vec");await import(root+"/index.js");' \
    "$memory_root"

  picturereader_root="$app_root/assets/plugins/picturereader"
  [[ -f "$picturereader_root/package.json" ]] || fail "picturereader manifest is missing"
  "$node_bin" --input-type=module -e \
    'const root=process.argv[1];const mod=await import(root+"/src/index.js");if(mod.name!=="picturereader"||typeof mod.apply!=="function")process.exit(2)' \
    "$picturereader_root"
  "$node_bin" -e \
    'const registry=require(process.argv[1]);const plugins=registry.COMPANION_PLUGINS;if(!plugins.some(p=>p.id==="picturereader"&&p.name==="picturereader")||plugins.some(p=>p.id==="tool-vision")||registry.PLUGIN_UPDATE_SOURCES.picturereader?.npm!=="picturereader")process.exit(2)' \
    "$app_root/lib/plugin-registry-data.js"

  mapfile -t native_payloads < <(find "$extract_dir" -type f \( -name '*.node' -o -name '*.so' -o -path '*/resources/node/node' \) | sort)
  [[ ${#native_payloads[@]} -gt 0 ]] || fail "no native payloads found"
  for required in node-pty sharp-linux-x64 koffi-linux-x64 jieba-linux-x64-gnu sqlite-vec-linux-x64; do
    printf '%s\n' "${native_payloads[@]}" | grep -q "$required" || fail "mandatory native payload is missing: $required"
  done

  elf_payloads=("$electron_bin" "$node_bin")
  for payload in "${native_payloads[@]}"; do
    if file "$payload" | grep -q 'ELF 64-bit.*x86-64' && [[ "$payload" != *linuxmusl* ]] && [[ "$payload" != *musl_x64* ]]; then
      elf_payloads+=("$payload")
    fi
  done
  for payload in "${elf_payloads[@]}"; do
    if ldd "$payload" | grep -q 'not found'; then
      ldd "$payload" >&2 || true
      fail "ldd reports a missing dependency: $payload"
    fi
  done
  node "$repo_dir/scripts/check-glibc.cjs" "${elf_payloads[@]}"
  echo "OK: archive, metadata, imports, ldd, and GLIBC audit passed"
done
