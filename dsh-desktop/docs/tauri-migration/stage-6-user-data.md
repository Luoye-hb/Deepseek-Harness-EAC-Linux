# Stage 6: User Data And WebView State Migration

Date: 2026-08-22

## Delivered

- User data resolution preserves `DSH_DESKTOP_USERDATA`, portable `data/`,
  Windows `%APPDATA%/Deepseek Harness EAC`, and Linux
  `~/.config/Deepseek Harness EAC` semantics.
- The main Tauri WebView uses a stable `user_data/webview/main` directory.
- Float WebViews use separate `user_data/webview/float/<sessionId>`
  directories. Session ids are restricted to safe path-component characters,
  and `.`/`..` are rejected explicitly.
- The Electron fallback exports localStorage, IndexedDB records, and cookies
  into a versioned, checksummed `webview-migration.json` file with mode `0600`
  on Unix. Writes are idempotent and use a temporary file plus rename.
- The Tauri main WebView validates the migration schema, source, and checksum
  before injecting localStorage and IndexedDB data. Tauri imports cookies with
  its native cookie API so HttpOnly cookies are retained.
- Successful import writes `webview-migration.completed.json` with mode `0600`
  on Unix and removes the cleartext migration file. The marker suppresses
  subsequent imports.
- Float initialization injects `window.__DSH_FLOAT__` and targets the float
  session in `dsh.sessions.current` before the WebView loads the loopback app.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml` (10 passed, 0 failed)
- `npm run typecheck`
- `node --test test/tauri-migration.test.ts test/webview-migration.test.ts`
  (5 passed, 0 failed)
- `git diff --check`

The Rust tests cover float path isolation, path traversal rejection, valid
import-script generation, checksum tampering rejection, completion-marker
suppression, and Linux directory permissions.

## Remaining Evidence

Stage 6 is implemented but is not an acceptance pass yet. The following still
require the target runtime environments:

- An actual Electron WebView export followed by a Tauri WebView import with
  real localStorage, IndexedDB, and HttpOnly cookie comparison.
- Windows WebView2 persistence and migration verification.
- Linux WebKitGTK persistence and migration verification.
- Existing-user, portable-user, and custom `DSH_HOME` end-to-end probes.

These items remain open until a Windows runner and a Linux desktop environment
can produce runtime evidence. No Electron removal decision is implied by this
record.
