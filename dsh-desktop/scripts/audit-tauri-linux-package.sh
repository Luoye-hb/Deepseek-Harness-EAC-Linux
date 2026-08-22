#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "required audit tool is unavailable: $1"; }

[[ $# -gt 0 ]] || { echo "usage: $0 <tauri-package> [package...]" >&2; exit 2; }
for tool in file find ldd realpath objdump; do need "$tool"; done

audit_tmp="$(mktemp -d /tmp/dsh-tauri-package-audit.XXXXXX)"
trap 'rm -rf "$audit_tmp"' EXIT

extract_package() {
  local package="$1" destination="$2"
  case "${package,,}" in
    *.pacman|*.pkg.tar.zst)
      need bsdtar
      bsdtar -xf "$package" -C "$destination"
      [[ -s "$destination/.PKGINFO" ]] || fail "pacman metadata .PKGINFO is missing"
      grep -Eq '^arch = x86_64$' "$destination/.PKGINFO" || fail "pacman package is not x86_64"
      [[ -s "$destination/.MTREE" ]] || fail "pacman metadata .MTREE is missing"
      [[ -s "$destination/.INSTALL" ]] || fail "pacman install script metadata .INSTALL is missing"
      ;;
    *.deb)
      need dpkg-deb
      [[ "$(dpkg-deb -f "$package" Architecture)" == "amd64" ]] || fail "deb package is not amd64"
      dpkg-deb -x "$package" "$destination"
      ;;
    *.rpm)
      need rpm
      need rpm2cpio
      need cpio
      local rpm_db="$audit_tmp/rpmdb"
      mkdir -p "$rpm_db"
      [[ "$(rpm --dbpath "$rpm_db" -qp --qf '%{ARCH}' "$package")" == "x86_64" ]] || fail "rpm package is not x86_64"
      (cd "$destination" && rpm2cpio "$package" | cpio -idm --quiet)
      ;;
    *.appimage)
      local appimage_copy="$audit_tmp/$(basename "$package")"
      cp "$package" "$appimage_copy"
      chmod +x "$appimage_copy"
      (cd "$destination" && "$appimage_copy" --appimage-extract >/dev/null)
      [[ -x "$destination/squashfs-root/AppRun" ]] || fail "AppImage AppRun is missing"
      ;;
    *) fail "unsupported package format: $package" ;;
  esac
}

find_one() {
  local label="$1" pattern="$2" root="$3" result
  result="$(find "$root" -type f -path "$pattern" -print -quit)"
  [[ -n "$result" ]] || fail "$label is missing (pattern: $pattern)"
  printf '%s\n' "$result"
}

for package in "$@"; do
  [[ -f "$package" ]] || fail "package is not a file: $package"
  package="$(realpath "$package")"
  echo "==> auditing Tauri package $package"
  extract_dir="$audit_tmp/extract-$(basename "$package")"
  mkdir -p "$extract_dir"
  extract_package "$package" "$extract_dir"
  root="$extract_dir"
  [[ -d "$root/squashfs-root" ]] && root="$root/squashfs-root"

  app_bin="$(find_one 'Tauri executable' '*/deepseek-harness-eac' "$root")"
  [[ -x "$app_bin" ]] || fail "Tauri executable is not executable: $app_bin"
  [[ "$app_bin" != *electron* ]] || fail "package executable is an Electron binary"
  if find "$root" -type f \( -name 'electron' -o -name 'electron.exe' -o -path '*/resources/electron*' \) -print -quit | grep -q .; then
    fail "Tauri package contains an Electron executable/resource"
  fi
  if find "$root" -type f -path '*/native/supervisor/index.node' -print -quit | grep -q .; then
    fail "Tauri package contains the retired N-API supervisor"
  fi
  while IFS= read -r -d '' native; do
    kind="$(file -b "$native")"
    case "$kind" in
      ELF\ 64-bit*\ x86-64*) ;;
      ELF\ *) fail "package contains a non-x86_64 ELF native artifact: $native ($kind)" ;;
      PE32*|Mach-O*) fail "package contains a foreign-platform native artifact: $native ($kind)" ;;
      *) fail "package contains an unrecognized native artifact: $native ($kind)" ;;
    esac
  done < <(find "$root" -type f \( -name '*.node' -o -name '*.so' -o -name '*.dll' -o -name '*.dylib' -o -name '*.bare' \) -print0)

  node_bin="$(find_one 'bundled Node' '*/node/node' "$root")"
  npm_cli="$(find_one 'bundled npm CLI' '*/npm/bin/npm-cli.js' "$root")"
  host_entry="$(find_one 'desktop-host entry' '*/desktop-host/main.js' "$root")"
  dsh_bin="$(find_one 'bundled DSH entry' '*/node_modules/@deepseek-ai/dsh/lib/bin.js' "$root")"
  desktop_file="$(find "$root" -type f -name '*.desktop' -print -quit)"
  icon_file="$(find "$root" -type f -path '*/icons/*' -name '*.png' -print -quit)"
  license_file="$(find "$root" -type f -iname 'LICENSE-MIT.txt' -print -quit)"
  [[ -n "$desktop_file" ]] || fail "desktop entry is missing"
  [[ -n "$icon_file" ]] || fail "desktop icon is missing"
  [[ -n "$license_file" ]] || fail "package license is missing"
  grep -q '^Exec=deepseek-harness-eac' "$desktop_file" || fail "desktop entry Exec does not target Tauri executable"
  [[ -x "$node_bin" ]] || fail "bundled Node is not executable"
  [[ -s "$host_entry" && -s "$dsh_bin" ]] || fail "bundled host/DSH entry is empty"
  [[ "$("$node_bin" --version)" == 'v24.19.0' ]] || fail "bundled Node is not v24.19.0"
  "$node_bin" "$npm_cli" --version >/dev/null || fail "bundled npm failed under bundled Node"

  # Tauri packages use <resource-root>/vendor/node/node while the custom
  # pacman layout uses <resource-root>/node/node. Find the root by the shared
  # node_modules sibling instead of assuming one package layout.
  app_root="$(dirname "$node_bin")"
  while [[ "$app_root" != / && ! -d "$app_root/node_modules" ]]; do
    app_root="$(dirname "$app_root")"
  done
  [[ -d "$app_root/node_modules" ]] || fail "bundled Node resource root is missing node_modules"
  node_pty_manifest="$(find "$app_root" -type f -path '*/node_modules/node-pty/package.json' -print -quit)"
  node_pty_root="${node_pty_manifest%/package.json}"
  [[ -n "$node_pty_root" && -d "$node_pty_root" ]] || fail "node-pty package is missing"
  "$node_bin" -e 'const pty=require(process.argv[1]);if(typeof pty.spawn!=="function")process.exit(2)' "$node_pty_root" || fail "bundled Node cannot import node-pty"
  "$node_bin" -e 'const root=process.argv[1];const sharp=require(root+"/node_modules/sharp");const koffi=require(root+"/node_modules/koffi");if(typeof sharp!=="function"||typeof koffi.load!=="function")process.exit(2)' "$app_root" || fail "bundled Node cannot import Sharp/Koffi"

  plugin_root="$app_root/assets/plugins/picturereader"
  [[ -f "$plugin_root/package.json" ]] || fail "picturereader plugin manifest is missing"
  "$node_bin" --input-type=module -e 'const root=process.argv[1];const mod=await import(root+"/src/index.js");if(mod.name!=="picturereader"||typeof mod.apply!=="function")process.exit(2)' "$plugin_root" || fail "picturereader plugin import failed"

  mapfile -t elf_payloads < <(
    while IFS= read -r -d '' candidate; do
      file -b "$candidate" | grep -q '^ELF 64-bit.*x86-64' && printf '%s\n' "$candidate"
    done < <(find "$root" -type f \( -name '*.node' -o -name '*.so' -o -name '*.bare' -o -path '*/node/node' \) -print0) | sort
  )
  elf_payloads+=("$app_bin")
  ((${#elf_payloads[@]} > 0)) || fail "no ELF/native payloads found"
  for payload in "${elf_payloads[@]}"; do
    if file "$payload" | grep -q 'ELF 64-bit.*x86-64' && [[ "$payload" != *linuxmusl* ]] && [[ "$payload" != *musl_x64* ]]; then
      if ldd "$payload" | grep -q 'not found'; then
        ldd "$payload" >&2 || true
        fail "ldd reports a missing dependency: $payload"
      fi
    fi
  done
  node "$repo_dir/scripts/check-glibc.cjs" "${elf_payloads[@]}"

  if find "$root" -type f -perm /002 -print -quit | grep -q .; then
    fail "package contains a group/world-writable file"
  fi
  echo "OK: Tauri executable, resources, imports, desktop metadata, ldd, permissions, and GLIBC audit passed"
done
