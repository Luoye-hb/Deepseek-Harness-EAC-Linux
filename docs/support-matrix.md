# Support Matrix

## Release targets

| Platform | Architecture | Packages | Runtime | Client update ownership |
| --- | --- | --- | --- | --- |
| Windows 10/11 | x86_64 | Portable, NSIS | Bundled official Node v24.19.0 | In-app updater |
| Linux | x86_64 | pacman, deb, rpm, AppImage | Bundled official Node v24.19.0 | Distribution package manager; AppImage is replaced manually |
| macOS | Any | None | None | Unsupported |

Only Windows x64 and Linux x86_64 are release targets. ARM builds and macOS are not built, tested, or supported.

## Linux compatibility gate

Linux packages are built and audited in Debian 12 CI. `node-pty` is rebuilt there with the official Node v24.19.0 distribution, never with a distribution `nodejs` package. Every pacman, deb, rpm, and AppImage archive must contain the bundled Node/npm runtime, Electron, node-pty, Sharp, Koffi, `dsh-tdai-memory`, Jieba, and sqlite-vec. Required ELF payloads must have no unresolved `ldd` dependency and must not reference a GLIBC symbol newer than `GLIBC_2.34`.

Linux lifecycle fencing uses a dedicated POSIX process group and a validated `0600` lease. It provides bounded `SIGTERM` to `SIGKILL` cleanup and stale-group recovery. It does not provide Windows Job Object resource limits, a cgroup v2 boundary, a low-privilege account sandbox, or guaranteed immediate cleanup after an uncatchable host crash; rejected or ambiguous leases are preserved as incident evidence and are never signalled.

## Update boundary

Windows retains portable and NSIS client self-update, rollback, and shortcut maintenance. Linux disables background client downloads, pending-update apply, Windows command scripts, rescue rollback, and shortcut maintenance. A manual Linux update check only reports package-manager or AppImage replacement guidance.
