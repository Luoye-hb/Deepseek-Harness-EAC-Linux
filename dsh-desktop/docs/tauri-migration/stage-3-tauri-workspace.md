# Stage 3: Tauri Workspace

Date: 2026-08-22

## Delivered

- Added `src-tauri` as a locked Cargo workspace using Tauri 2.
- Added the main window label and a local loading document.
- Added a Rust `desktop-host` manager using the existing 4 MiB framed stdio
  protocol.
- Rust resolves the bundled Node runtime, `desktop-host/main.js`, and the dsh
  CLI from packaged resources or explicit `DSH_DESKTOP_*` overrides.
- Host startup accepts only HTTP loopback URLs and requires a real HTTP 200
  response before emitting `desktop-host.ready`.
- Added typed `desktop-host.ready`, `desktop-host.state`, and
  `desktop-host.error` events.
- Added an explicit command allowlist and main-window label checks. Generic
  Tauri shell, filesystem, and process APIs are not enabled in the capability
  file.
- Added an OS-owned single-instance guard: Linux uses an exclusive `flock` in
  the preserved user-data directory and Windows uses a named mutex. A crashed
  process cannot leave a stale lock.
- Added Rust loopback validation tests and package scripts for Cargo check,
  test, and format verification.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml` (10 passed, 0 failed)

## Not Yet Complete

- Windows cross-compilation and WebView2 runtime verification.
- Linux WebKitGTK runtime smoke test.
- Windows Job Object and Linux process-group runtime evidence.
- User-data/WebView migration, Portable packaging, signed updater, rollback,
  preview observation, and Electron removal.

The Electron path remains the default fallback until the later plan gates are
passed.
