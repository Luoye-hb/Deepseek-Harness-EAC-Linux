# Upstream Sync Record

Copy this template for each synchronization from the Electron upstream.

## Metadata

- Date:
- Integration branch: `codex/upstream-sync-YYYYMMDD`
- Upstream remote:
- Upstream commit range:
- Local target branch:
- Resulting local commit:

## Classification

| Category | Commits / files | Action | Reason |
| --- | --- | --- | --- |
| Shared business | | merge / port | |
| Shared contract or IPC | | update contract, then adapt both shells | |
| Electron shell | | behavior port only | |
| Windows-specific | | port / ignore | |
| Electron-only build or release | | ignore | |
| Security or recovery fix | | merge / port with tests | |

## Required Checks

- [ ] Shared TypeScript typecheck
- [ ] Shared unit tests
- [ ] Desktop-host/RPC contract tests
- [ ] Electron fallback tests
- [ ] Windows Tauri tests, if applicable
- [ ] Linux Tauri tests, if applicable
- [ ] Packaging and native-module checks, if applicable
- [ ] No Electron-only build change entered the Tauri release chain

## Notes

### Directly merged

-

### Manually ported

-

### Explicitly ignored

-

### Verification and remaining risk

-
