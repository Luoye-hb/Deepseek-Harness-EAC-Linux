#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging="${DSH_TAURI_STAGING:-$repo_dir/.tauri-staging}"
binary="${TAURI_BINARY:-$repo_dir/src-tauri/target/release/deepseek-harness-eac}"
version="${DSH_PACKAGE_VERSION:-$(node -p "require('./package.json').version")}"
package_root="$repo_dir/.tauri-pacman-root"
output_dir="${TAURI_PACKAGE_OUTPUT:-$repo_dir/dist/tauri}"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ -x "$binary" ]] || die "Tauri release executable is missing or not executable: $binary"
[[ -d "$staging" ]] || die "Tauri staging tree is missing: $staging"
command -v makepkg >/dev/null || die "makepkg is required to build the pacman package"

rm -rf "$package_root"
mkdir -p "$package_root/usr/bin" "$package_root/usr/lib/deepseek-harness-eac/resources"
install -m 0755 "$binary" "$package_root/usr/bin/deepseek-harness-eac"

copy_resource() {
  local source="$1" target="$2"
  [[ -e "$staging/$source" ]] || die "staging resource is missing: $source"
  cp -a "$staging/$source" "$package_root/usr/lib/deepseek-harness-eac/resources/$target"
}

for resource in desktop-host shared lib scripts balance.js logger.js updater.js \
  plugin-updater.js session-watcher.js patch-row-heal.js plugin-guard.js \
  plugin-manager-state.js package.json node_modules assets; do
  copy_resource "$resource" "$resource"
done
copy_resource vendor/node node
copy_resource vendor/npm npm

mkdir -p "$package_root/usr/share/applications" \
  "$package_root/usr/share/icons/hicolor/512x512/apps" \
  "$package_root/usr/share/licenses/deepseek-harness-eac"
cat > "$package_root/usr/share/applications/deepseek-harness-eac.desktop" <<'EOF'
[Desktop Entry]
Name=Deepseek Harness EAC
Comment=DeepSeek Harness desktop client
Exec=deepseek-harness-eac %U
Icon=deepseek-harness-eac
Terminal=false
Type=Application
Categories=Development;
MimeType=x-scheme-handler/dsh;
EOF
install -m 0644 "$repo_dir/assets/icon.png" \
  "$package_root/usr/share/icons/hicolor/512x512/apps/deepseek-harness-eac.png"
install -m 0644 "$repo_dir/packaging/LICENSE-MIT.txt" \
  "$package_root/usr/share/licenses/deepseek-harness-eac/LICENSE-MIT.txt"

mkdir -p "$output_dir"
# makepkg --force replaces the archive but may retain files in its pkgdir from
# an earlier staging target. Clear only makepkg's generated trees so a Windows
# prebuild cannot survive into a Linux package.
rm -rf "$repo_dir/packaging/linux/pkg" "$repo_dir/packaging/linux/src"
DSH_TAURI_PACKAGE_ROOT="$package_root" \
DSH_PACKAGE_VERSION="$version" \
PKGDEST="$output_dir" \
SRCDEST="$repo_dir/.tauri-pacman-src" \
makepkg --clean --force --noconfirm \
  --dir "$repo_dir/packaging/linux"
echo "Pacman package written to $output_dir"
