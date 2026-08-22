# Tauri Migration Records

This directory contains evidence and working records for the Windows/Linux
Tauri migration described in `planplan.md`.

## Current Status

- Migration branch: `codex/tauri-migration`
- Current base commit: `ff6324e` (`merge: reconcile upstream Linux history with TypeScript architecture`)
- Electron remains the only runnable desktop shell.
- `shared/contract` now contains the first shell-neutral desktop API and
  desktop-host protocol types.
- `DesktopPlatform` defines the shell injection boundary for native windows,
  dialogs, clipboard, notifications, external URLs, and shortcuts.
- `platform/electron-fallback` provides the first injectable implementation;
  its window, dialog, notification, shell, clipboard, and shortcut behaviors
  are covered by fake-dependency tests.
- Existing Electron modules now route message boxes, notifications, external
  URLs, file opening/location, and text clipboard writes through the fallback
  adapter. Window construction, tray menus, and Electron-specific recovery
  hooks remain in their original modules until their lifecycle contract is
  extracted.
- `desktop-host/main.ts` can start/stop dsh web through stdio RPC and only
  reports readiness after loopback HTTP 200.
- `src-tauri` now contains the first Tauri 2 workspace, loading window,
  typed host events, Rust stdio host manager, loopback HTTP validation, and
  restricted main-window commands.
- Tauri startup now has an OS-owned single-instance guard matching the shell
  requirement; Electron remains available as the migration fallback.
- `desktop-host/service.ts` now owns host-side dsh lifecycle, concurrent-start
  coalescing, status, intentional-stop classification, and `dsh.exit`
  notifications.
- Stage 6 now assigns the main WebView a stable `user_data/webview/main`
  directory and each float window an isolated
  `user_data/webview/float/<sessionId>` directory. Float session ids are
  validated before they are used as path components.
- The Electron WebView export and Tauri import paths now have checksum,
  tampering, completion-marker, cookie, and storage initialization coverage.
- `platform/electron-fallback/desktop-host-client.ts` drives that service from
  Electron. The existing server path remains the default; setting
  `DSH_DESKTOP_HOST_RPC=1` enables the RPC path with graceful host shutdown and
  restart support.
- The existing Electron preload consumes the shared desktop API types and keeps
  the current IPC channels unchanged.
- `.github/workflows/tauri.yml` now runs shared checks plus real Windows NSIS,
  Debian 12 package, and Arch pacman package jobs. It deliberately does not
  claim Portable, signed updater, WebView2/WebKitGTK E2E, or preview-period
  evidence.

## Records

- [`baseline-2026-08-22.md`](baseline-2026-08-22.md): stage 0 build, test,
  startup, packaging, and process evidence.
- [`desktop-bridge-matrix.md`](desktop-bridge-matrix.md): the 34 existing
  Electron IPC capabilities and their migration boundary.
- [`upstream-sync-template.md`](upstream-sync-template.md): required
  classification record for each upstream synchronization.
- [`stage-3-tauri-workspace.md`](stage-3-tauri-workspace.md): stage 3
  workspace and verification record.
- [`stage-4-5-security-process.md`](stage-4-5-security-process.md): current
  Rust process-fence, bounded RPC, origin-security, and drag/drop bridge
  evidence for stages 4 and 5.
- [`stage-6-user-data.md`](stage-6-user-data.md): stage 6 storage isolation,
  migration implementation, tests, and remaining runtime evidence.

The baseline is intentionally recorded with the pre-existing dirty worktree
visible. It is not evidence that unrelated pending changes were authored by
the Tauri migration.
