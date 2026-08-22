# Support Matrix

## Release targets

| Platform | Architecture | Packages | Runtime | Client update ownership |
| --- | --- | --- | --- | --- |
| Linux | x86_64 | pacman, deb, rpm, AppImage | Bundled official Node v24.19.0 | Distribution package manager; AppImage is replaced manually |

This branch builds, tests, and releases Linux x86_64 only. Windows and macOS are not release targets for this branch. Windows source and workflows inherited from upstream remain in the repository solely to keep future upstream merges reviewable; they are not modified or used as Linux release evidence.

## Linux compatibility gate

Linux packages are built and audited in Debian 12 CI. `node-pty` is rebuilt there with the official Node v24.19.0 distribution, never with a distribution `nodejs` package. Every pacman, deb, rpm, and AppImage archive must contain the bundled Node/npm runtime, Electron, node-pty, Sharp, and Koffi. Required ELF payloads must have no unresolved `ldd` dependency and must not reference a GLIBC symbol newer than `GLIBC_2.34`.

Linux lifecycle fencing uses a dedicated POSIX process group and a validated `0600` lease. It provides bounded `SIGTERM` to `SIGKILL` cleanup and stale-group recovery. It does not provide cgroup v2 resource limits, a low-privilege account sandbox, or guaranteed immediate cleanup after an uncatchable host crash; rejected or ambiguous leases are preserved as incident evidence and are never signalled.

## Update boundary

Linux disables background client downloads, pending-update apply, command-script replacement, rescue rollback, and shortcut maintenance. A manual update check only reports package-manager or AppImage replacement guidance.

## Upstream synchronization

The upstream Windows implementation is kept as an unchanged compatibility baseline, not as a supported product surface. Linux work should remain in Linux-specific modules, builder sections, tests, and `.github/workflows/linux.yml`; shared composition files should contain only thin platform dispatch. Upstream updates are integrated with a normal merge, then the Linux compatibility gate above is rerun.
