# Desktop Bridge Compatibility Matrix

The current Electron implementation exposes 34 IPC capabilities. This list is
the migration inventory for stage 1 and the compatibility gate for the Tauri
adapter. Channel names remain unchanged during the Electron fallback period.

| # | Current channel | Kind | Source boundary | Target contract | Security / ownership |
| ---: | --- | --- | --- | --- | --- |
| 1 | `chrome:init` | invoke | main window | `getInfo()` | main-window sender check |
| 2 | `chrome:window` | invoke | main window | `windowControls.*` | main-window sender check |
| 3 | `chrome:menu` | invoke | main window | `menu.action()` | main-window sender check |
| 4 | `chrome:restart-service` | invoke | main window | `restartService()` | intent + main-window check |
| 5 | `dsh:copy-text` | invoke | main window | `copyText()` | bounded text + sender check |
| 6 | `dsh:page-error` | send | main window | diagnostic event | main-window sender check |
| 7 | `dsh:open-external` | invoke | main window | `openExternal()` | `http(s)` only |
| 8 | `chrome:float-window` | invoke | main window | `floatWindow.open()` | session id + max 8 windows |
| 9 | `float:close` | send | float window | `floatWindow.close()` | sender must own the float |
| 10 | `dsh:balance-refresh` | invoke | main window | `refreshBalance()` | main-window sender check |
| 11 | `dsh:balance-prices-get` | invoke | main window | `balancePrices.get()` | main-window sender check |
| 12 | `dsh:balance-prices-set` | invoke | main window | `balancePrices.set()` | model and price validation |
| 13 | `dsh:balance-prices-reset` | invoke | main window | `balancePrices.reset()` | main-window sender check |
| 14 | `dsh:file-revert` | invoke | main window | `revertFiles()` | cwd roots, size, exact-content checks |
| 15 | `dsh:file-open` | invoke | main window | `openPath()` | roots, skills allowlist, extension denylist |
| 16 | `guard:action` | invoke | main window | `guard.action()` | action-specific recovery rules |
| 17 | `dsh:plugin-list` | invoke | main window | `pluginManager.list()` | main-window sender check |
| 18 | `dsh:plugin-set-enabled` | invoke | main window | `pluginManager.setEnabled()` | row allowlist + sender check |
| 19 | `dsh:plugin-set-removed` | invoke | main window | `pluginManager.setRemoved()` | plugin registry policy |
| 20 | `dsh:plugin-updates` | invoke | main window | `pluginUpdates.list()` | built-in source allowlist |
| 21 | `dsh:plugin-update` | invoke | main window | `pluginUpdates.update()` | built-in source allowlist |
| 22 | `dsh:plugin-auto-update` | invoke | main window | `pluginUpdates.setAutoUpdate()` | settings validation |
| 23 | `dsh:image-paste-save` | invoke | main window | `imagePaste.save()` | image data URL, size, filename checks |
| 24 | `onboard:list` | invoke | wizard window | wizard adapter | wizard sender check |
| 25 | `onboard:submit` | invoke | wizard window | wizard adapter | selection allowlist |
| 26 | `onboard:close` | send | wizard window | wizard adapter | wizard sender check |
| 27 | `onboard:open` | invoke | main window | `pluginWizard.open()` | main-window sender check |
| 28 | `dsh:renderer-heartbeat` | send | main window | recovery event | renderer identity tracking |
| 29 | `chrome:recovery-state` | invoke | main window | `recovery.getState()` | main-window sender check |
| 30 | `chrome:recovery-reload` | invoke | main window | `recovery.reload()` | guarded service restart |
| 31 | `chrome:recovery-restart` | invoke | main window | `recovery.restart()` | clean-exit marker + relaunch |
| 32 | `chrome:export-logs` | invoke | main window | `recovery.exportLogs()` | diagnostic archive boundary |
| 33 | `rc:close` | send | recovery window | recovery-center adapter | recovery-window sender check |
| 34 | `rc:action` | invoke | recovery window | recovery-center adapter | recovery-window sender check |

## Passive Events

The current preload also forwards passive events that are not counted in the
34 request capabilities:

- `chrome:maximized` -> `window.maximized`
- `dsh:balance` -> `balance.changed`
- page error reports -> diagnostic logging
- renderer heartbeat -> `recovery.state` input

The shell-neutral event names and payload types are defined in
`shared/contract/events.ts`. The Tauri adapter must preserve source-window
authorization and must not expose general-purpose Tauri shell, filesystem, or
process APIs to the page.

## Window Roles

The current roles that require explicit authorization are:

- `main`
- `float`
- `wizard`
- `recovery`
- `update`

The first four have active code paths today. Update-window behavior is owned by
the update flow and must be included before Electron is removed.
