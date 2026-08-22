# Tauri 迁移工作归档

日期：2026-08-22

## 已完成并验证

- 已阅读并按 `planplan.md` 梳理 Tauri Windows/Linux 双平台迁移要求。
- 当前分支：`codex/tauri-migration`。
- 工作树存在大量迁移期已有修改、删除和未跟踪文件；本次审计未回退任何既有改动。
- `npm run build`：通过。
- `npm test`：580 pass，9 skipped，0 fail（589 项）。
- `npm run typecheck`：通过。
- `cargo fmt --check`：通过。
- `cargo check`：通过。
- `cargo test`：10 passed，0 failed。
- `cargo clippy --all-targets -- -D warnings`：通过。
- 已保留 Electron fallback，未满足计划中的最终删除条件。
- 已修复 clean `DSH_HOME` 下插件依赖闭包不完整的问题：
  - 新增 `shared/desktop-core/profile-runtime.ts`。
  - 启动 DSH 前补齐 bundled 插件依赖的 fallback links。
  - 已验证 `dsh-balance` 能复制、登记并随插件树正常加载。
  - 真实 bundled DSH host 已返回 loopback HTTP 200。
- 已重新编译当前 Tauri release 二进制并刷新 `.tauri-staging`；未生成新的发行包。
- 已在 Arch Linux 真实 Tauri 进程上验证生命周期：
  - 外部 `SIGTERM`：app 退出码 0，host、DSH、后代进程和 lease 全部消失。
  - 外部 `SIGKILL`：app 退出码 137，依靠 Linux `PDEATHSIG`，host、DSH、后代进程和 lease 全部消失。
  - `desktop-host` RPC 异步 writer `EPIPE` 回归通过，不产生未处理异常。

## 已执行但不再继续投入

- 已生成 Arch pacman 包：
  `/tmp/dsh-tauri-pacman-output/deepseek-harness-eac-4.6.0-1-x86_64.pkg.tar.zst`
- 已发现当前构建机主二进制引用 `GLIBC_2.39`，不满足计划要求的 `GLIBC <= 2.34`。
- 该问题属于构建基线/工具链问题，未继续扩展到 deb、rpm、AppImage 或 Windows 打包。

## 本次审计修复

- `desktop-host/rpc.ts`：监听 Writable 异步 error，并在写端关闭时停止发送。
- `desktop-host/main.ts`：统一异步 shutdown，处理 `SIGTERM`、`SIGINT`、stdin end 和异常退出。
- `shared/desktop-core/dsh-web.ts`：Linux 停止 DSH 时按进程组发送 `SIGTERM -> SIGKILL`。
- `src-tauri/src/process/host.rs`：Linux host spawn 时设置 `PR_SET_PDEATHSIG`，并处理 fork/exec 竞态；将 lease 路径传给 host。
- `src-tauri/src/lib.rs`：Linux 捕获 SIGTERM/SIGINT，在退出前调用 `HostManager::stop()`，覆盖 Tauri `ExitRequested` 不会触发的外部 signal 路径。

## 后续修复

- 修复 Tauri 首次启动时插件安装向导不出现：在 `dsh:start` 创建 profile 和同步插件之前冻结首次使用判定，避免新用户被新建的 `node_modules` 目录误判为已有用户；新增 desktop-host RPC 回归测试。
- 修复损坏的既有 `settings.json` 在恢复时被误判为首次使用的问题：先记录文件和 profile 的存在状态，再读取并恢复设置。
- 修复 Tauri shared CI 的诊断 zip 测试缺少 `bsdtar`：Ubuntu job 显式安装 `libarchive-tools`。
- 修复 Windows `fetch-node` 的 PowerShell 解压参数未绑定问题，改为 `param($archive, $destination)` 脚本块，并添加回归检查。
- 将 settings 持久化失败回归从目录权限模拟改为显式注入原子替换失败，因此可在 root 容器和 Windows runner 中稳定运行。
- 串行化 Rust Linux fence 测试对 `DSH_DESKTOP_USERDATA` 的进程全局环境修改，消除并发创建同一 lease 临时文件的竞态。
- Tauri shared CI 安装完整的 GTK/WebKit 编译依赖，使 Ubuntu 上的 Cargo 检查与 Linux 打包环境一致。
- `startDshWeb()` 启动失败后会等待子进程退出再返回错误，避免 Windows 尚未释放运行时文件句柄时留下临时目录。
- 将 Linux/POSIX 专属的测试断言限定到相应平台，并使打包配置审计对 CRLF/LF 无关，恢复 Windows CI 的有效覆盖。

## 仍未完成的计划门禁

- host crash、DSH crash、WebView hang 的真实 Tauri 回归尚未逐项完成。
- Windows WebView2、NSIS/Portable、签名 updater、升级/回退/卸载和真实迁移尚未完成。
- Linux deb、rpm、pacman、AppImage 全套包审计尚未完成；打包按用户要求暂停。
- 当前构建机产物引用 `GLIBC_2.39`，不满足计划的 `GLIBC <= 2.34` 门禁。
- 原生模块、clean HOME、已有用户数据、Portable、自定义 `DSH_HOME` 逐项比对、两个 preview 和连续 14 天观察尚未完成。
- Electron 删除条件尚未满足。
