#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="${TAURI_CONFIG:-$repo_dir/src-tauri/tauri.generated.conf.json}"
bundle_root="$repo_dir/src-tauri/target/release/bundle"
appimage_root="$bundle_root/appimage"
output_dir="${TAURI_PACKAGE_OUTPUT:-$appimage_root}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$config" ]] || die "generated Tauri config is missing: $config"

# Tauri creates the AppDir before its default linuxdeploy invocation. The
# optional dependency pass cannot handle static landlock-run or musl Koffi on
# all build images, so keep it disabled unless a builder explicitly opts in.
tauri_status=0
if [[ "${TAURI_SKIP_BUILD:-0}" != "1" ]]; then
  command -v npx >/dev/null || die "npx is required"
  set +e
  (cd "$repo_dir" && NO_STRIP=1 npx tauri build --config "$config" --bundles appimage)
  tauri_status=$?
  set -e
fi

appdir="$(find "$appimage_root" -mindepth 1 -maxdepth 1 -type d -name '*.AppDir' -print -quit 2>/dev/null || true)"
[[ -n "$appdir" && -d "$appdir" ]] || die "Tauri did not create an AppDir (status $tauri_status)"

resource_root="$(find "$appdir/usr/lib" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null || true)"
main_binary="$appdir/usr/bin/deepseek-harness-eac"
[[ -d "$resource_root/node_modules" ]] || die "AppDir Node resources are missing"
[[ -x "$main_binary" ]] || die "AppDir Tauri executable is missing: $main_binary"

linuxdeploy="${LINUXDEPLOY:-$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage}"
appimage_plugin="${LINUXDEPLOY_PLUGIN_APPIMAGE:-$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage}"
if [[ "${TAURI_RUN_LINUXDEPLOY_DEPS:-0}" == "1" ]]; then
  [[ -x "$linuxdeploy" ]] || die "linuxdeploy is missing: $linuxdeploy"
fi
[[ -x "$appimage_plugin" ]] || die "linuxdeploy AppImage plugin is missing: $appimage_plugin"

stash="$(mktemp -d "${TMPDIR:-/tmp}/dsh-tauri-appimage.XXXXXX")"
moved=()
restore_native() {
  local relative
  for relative in "${moved[@]}"; do
    mkdir -p "$appdir/$(dirname "$relative")"
    mv "$stash/$relative" "$appdir/$relative"
  done
  rmdir "$stash" 2>/dev/null || true
}
trap restore_native EXIT

if [[ "${TAURI_RUN_LINUXDEPLOY_DEPS:-0}" == "1" ]]; then
  while IFS= read -r -d '' file; do
    relative="${file#"$appdir/"}"
    mkdir -p "$stash/$(dirname "$relative")"
    mv "$file" "$stash/$relative"
    moved+=("$relative")
  done < <(
    find "$resource_root/node_modules" -type f \( \
      -name 'landlock-run' -o \
      -path '*/musl_*/*.node' \
    \) -print0
  )

  NO_STRIP=1 "$linuxdeploy" --appimage-extract-and-run \
    --verbosity 1 \
    --appdir "$appdir" \
    --deploy-deps-only "$main_binary"
fi

restore_native
trap - EXIT

mkdir -p "$output_dir"
# appimagetool resolves Icon= from the desktop entry against the AppDir root.
# Tauri's generated icon retains the product name, while the desktop entry uses
# the stable application identifier.
install -m 0644 "$repo_dir/assets/icon.png" "$appdir/deepseek-harness-eac.png"
(cd "$output_dir" && NO_STRIP=1 "$appimage_plugin" --appimage-extract-and-run --appdir "$appdir")
generated="$output_dir/Deepseek_Harness_EAC-x86_64.AppImage"
[[ -f "$generated" ]] || die "AppImage plugin did not create $generated"
target="$output_dir/Deepseek Harness EAC_$(node -p "require('$repo_dir/package.json').version")_amd64.AppImage"
mv "$generated" "$target"
chmod 0755 "$target"

echo "AppImage written to $target"
