# Stages 4-5: Process Supervision And Tauri Bridge

Date: 2026-08-22

## Delivered In The Current Workspace

- Rust supervises the desktop-host through a Linux process group or a
  Windows Job Object configured with `KILL_ON_JOB_CLOSE`.
- Linux leases are written atomically with mode `0600`, validate the process
  start time, executable, command line, and process-group identity, and use a
  bounded `SIGTERM` to `SIGKILL` cleanup.
- Linux cleanup checks the process group rather than only the group leader, so
  descendants are reaped after the leader exits.
- Rust stdio RPC reads reject oversized frames and have bounded ordinary
  request and shutdown deadlines. A timeout falls through to fence cleanup.
- The compiled Tauri bridge exposes the shell-neutral `window.dshDesktop`
  contract and keeps the page away from generic Tauri shell/fs/process APIs.
- Native drag/drop paths are cached only for the current transaction. Both
  `files.onDrop()` and legacy `getPathForFile(file)` consume that cache.
- Tauri internal origins are restricted to `tauri://localhost` or
  `https://tauri.localhost`; loopback navigation compares the exact runtime
  origin and supports IPv4/IPv6 loopback addresses.
- Renderer page errors are bounded and routed through desktop-host logging;
  renderer heartbeats are accepted only from the main window and a visible
  main-window timeout opens the recovery window.
- Wizard cancellation persists the onboarding completion marker through the
  same desktop-host business service as submission. Recovery retry and close
  use their Rust window commands rather than bypassing window navigation.
- Windows external URL and validated-path opening use `explorer.exe` directly;
  untrusted values are not passed through `cmd /C start`.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml` (10 passed, 0 failed)
- `npm run typecheck`
- `npm run build`
- `node scripts/test-runner.js test/tauri-drop-path.test.ts test/tauri-migration.test.ts`
- `node scripts/test-runner.js test/desktop-host-main.test.ts`

## Remaining Runtime Evidence

- Windows Job Object behavior still requires a Windows runner with real
  desktop-host descendants and forced termination tests.
- Linux clean-HOME, real WebKitGTK, host crash, DSH crash, and stale-lease
  tests still require a desktop-capable Debian environment.
- WebView2/WebKitGTK E2E for all 34 bridge capabilities and representative
  plugins is not implied by compile or source tests.
- The migration CI now has Windows NSIS, Debian 12 deb/rpm/AppImage, and Arch
  pacman build/audit jobs. It does not provide a Portable gate or runtime
  WebView2/WebKitGTK E2E. No updater-signature, rollback, or preview-period
  evidence is claimed here.
- Tauri remains a migration path and Electron remains the default fallback
  until the later packaging, upgrade, preview, and rollback gates pass.
