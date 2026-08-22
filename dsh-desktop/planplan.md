# Windows/Linux 双平台 Tauri 重构 Coding Plan

## 1. 目标与最终形态

将当前 Electron 桌面客户端重构为一个**同仓库、同长期分支、Windows 和 Linux 均使用 Tauri 2 壳**的项目。

最终架构：

```text
Tauri 2 / Rust 原生壳
    │ typed commands/events
    ▼
TypeScript desktop-host（bundled Node 24.19.0）
    │
    ├── dsh web
    ├── 插件、市场、设置、会话、更新与恢复
    └── Extension Hosts
```

平台目标：

- Windows x64：Tauri + WebView2，NSIS、Portable。
- Linux x86_64：Tauri + WebKitGTK，pacman、deb、rpm、AppImage。
- Windows 与 Linux 共用 TypeScript 业务、协议、插件和用户数据语义。
- Windows 与 Linux 的原生差异只存在于 Rust/Tauri 平台适配和打包层。
- Electron 只作为迁移期 fallback，最终删除，不作为长期平台实现。
- 不重写 DSH、Cordis、插件管理或 Extension Host 为 Rust。

非目标：

- 不增加 macOS、ARM 或移动端。
- 不改变 DSH、Cordis、插件 SDK 和用户配置格式。
- 不以删除 Node/npm、Sharp、node-pty、Koffi 或插件资源换取体积。

## 2. 关键决策

### 2.1 分支策略

- 使用一个长期主分支维护 Windows Tauri 和 Linux Tauri。
- 不建立长期 `windows` / `linux` 分支。
- 迁移初期可使用短期 `codex/tauri-migration` 分支。
- 迁移期间保留 Electron 可运行和可构建的 fallback。
- Tauri preview 使用 release channel/tag，不创建长期 preview 分支。

### 2.2 上游同步策略

当前上游仍然是 Electron，因此不能把上游主分支作为可直接合并的桌面壳来源。

每次同步使用临时集成分支：

```text
upstream/main（Electron）
        │
        ▼
codex/upstream-sync-YYYYMMDD（干净同步与分类）
        │
        ▼
main（Windows/Linux Tauri）
```

上游提交分类：

1. 共享业务变化：直接合并或小范围移植。
2. 共享 contract / IPC 变化：先更新 contract，再实现两个 Tauri adapter。
3. Electron 壳变化：不直接合并实现，只移植行为、修复意图和测试。
4. Windows 专属变化：判断是否与 Tauri Windows 实现相关，必要时重新实现。
5. 上游 Electron-only 构建或发布变化：不进入最终 Tauri 构建链。

每次同步必须记录：

- 上游 commit 和版本。
- 可直接合并的共享变化。
- 需要手工移植的平台变化。
- 明确忽略的 Electron-only 变化。
- Windows/Linux 双平台验证结果。

### 2.3 平台边界

共享层不得直接导入 Electron、Tauri、Win32 或 Linux 专属 API。

共享层负责：

- DSH 启动和 HTTP 就绪检测。
- 插件、市场、设置、profile、session、guard。
- agent/client 更新业务和状态机。
- 恢复中心、诊断和日志。
- Extension Host 管理语义。
- `window.dshDesktop` contract。

Tauri/Rust 平台层负责：

- 单实例。
- 主窗、浮窗、向导、更新窗、恢复中心窗口。
- 托盘、通知、对话框、剪贴板、文件/URL 打开。
- 快捷键、拖放原生事件。
- desktop-host 进程监管和最终回收。
- 平台签名、安装、升级和卸载集成。

## 3. 目标目录结构

目标结构如下；迁移期间可以逐步移动文件，不要求一次性重排：

```text
shared/
  contract/
    desktop-api.ts
    desktop-host.ts
    errors.ts
    events.ts
  desktop-core/
  business/
  plugins/
  updater/
  recovery/

desktop-host/
  main.ts
  rpc/
  bootstrap/

src-tauri/
  Cargo.toml
  Cargo.lock
  tauri.conf.json
  capabilities/
  src/
    main.rs
    commands.rs
    events.rs
    state.rs
    platform/
      common.rs
      windows.rs
      linux.rs
    process/
      common.rs
      windows_job.rs
      linux_process_group.rs
    windows/
      installer.rs
      shortcuts.rs
    linux/
      desktop_entry.rs
      package.rs

platform/
  electron-fallback/
    main/
    preload/
  tauri/
    bridge/

packaging/
  windows/
    nsis/
    portable/
  linux/
    deb/
    rpm/
    pacman/
    appimage/

test/
  shared/
  tauri/
  windows/
  linux/
  fixtures/
```

迁移完成后删除：

- Electron 主入口和 Electron preload。
- Electron adapter。
- `electron-builder` 依赖和配置。
- N-API supervisor 包装层。
- 仅服务 Electron 的构建和发布脚本。

## 4. 共享 contract 设计

保持现有 `window.dshDesktop` 字段、方法名和返回语义兼容。

新增或统一以下类型：

```ts
export type DesktopShell = 'electron' | 'tauri';

export interface DesktopHostRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface DesktopHostResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export interface DesktopHostEvent {
  event: string;
  payload: unknown;
}
```

协议要求：

- 使用现有 4 MB 长度前缀 RPC。
- `stdout` 只输出协议帧；日志进入 `stderr` 和原日志文件。
- 请求 ID 必须唯一，禁止重复 ID。
- 普通请求默认 15 秒超时。
- 安装、更新、日志导出使用长任务事件，不使用无限等待请求。
- 对畸形帧、超限帧、未知方法、重复 ID、sidecar 退出统一记录事故并进入恢复流程。
- 协议按版本演进，新增字段必须向后兼容；破坏性变化升级协议版本。

公共 API：

- 保留全部现有 `window.dshDesktop` 能力。
- `ChromeInfo` 增加可选 `desktopShell`，仅供诊断展示。
- 新增 `files.onDrop(callback)`。
- 保留 `getPathForFile(file)` 作为兼容方法。
- 页面不得获得通用 Tauri shell/fs/process API。

## 5. 分阶段实施

### 阶段 0：基线、保护和同步准备

任务：

- 建立迁移分支，记录当前分支和工作树状态。
- 固化 Windows/Linux 功能对等清单。
- 记录启动时间、HTTP 就绪时间、内存、包体积和退出残留进程。
- 梳理 34 个桌面 IPC、窗口、浮窗、向导、更新窗、恢复中心、托盘、通知、快捷键、拖放和剪贴板。
- 建立上游同步分类模板。
- 保存最后一个可用 Electron tag 作为回退点。

完成标准：

- Electron 当前版本可构建、可启动、可退出。
- 有 Windows 和 Linux 基线报告。
- 有明确的迁移回退路径。

### 阶段 1：抽取壳无关 TypeScript 核心

任务：

- 将 `DshDesktopApi`、命令、响应、事件迁入共享 contract。
- 将直接导入 Electron 的文件拆为业务服务和平台适配器。
- 重点处理当前 `main.ts`、`lib/window.ts`、`lib/tray.ts`、`lib/proc.ts`、`lib/ipc/*`、`preload/api.ts`。
- 引入 `DesktopPlatform` 接口。
- 先实现 Electron fallback adapter，确保行为不变。
- 共享层保持 `strict: true`、`allowJs: false`、Node 24 类型基线。

完成标准：

- shared/core 不再直接导入 Electron。
- Electron fallback 仍通过原有测试。
- 新增平台接口测试和 contract 测试。

### 阶段 2：建立 desktop-host 和 RPC

任务：

- 新增 bundled Node 启动的 `desktop-host` 入口。
- 将原 Electron main 中的业务装配迁入 desktop-host。
- 启动 dsh web 并报告真实 loopback URL。
- 实现请求、响应、通知、取消、超时和错误结构。
- 禁止 Node host 开放 TCP 管理端口，仅允许父子进程 stdio。
- 将 host 崩溃、协议异常、DSH 崩溃接入现有恢复状态机。

完成标准：

- desktop-host 可独立启动和停止。
- Electron fallback 可通过 RPC 驱动 shared/core。
- RPC contract 测试覆盖正常、超时、畸形、超限、重复 ID 和 host 退出。

### 阶段 3：建立 Tauri 2 workspace

任务：

- 新增 `src-tauri` workspace 和固定 `Cargo.lock`。
- 定义共享 Tauri commands/events。
- 建立窗口标签、命令授权和状态管理。
- 启动时显示本地 loading 页面。
- host 报告 URL 后，由 Rust 验证 loopback origin 和 HTTP 200，再加载 Web UI。
- 实现主窗、浮窗、向导、更新窗、恢复中心的统一窗口模型。

完成标准：

- Windows/Linux 均可编译 Tauri 壳。
- 主窗能加载真实 DSH Web UI。
- 无授权的页面 API、错误窗口和错误 origin 请求均被拒绝。

### 阶段 4：迁移 Rust supervisor 和进程监管

任务：

- 将 `native/supervisor` 从 N-API `cdylib` 改为 Tauri workspace 内部 crate/module。
- Windows 实现 Job Object `KILL_ON_JOB_CLOSE`。
- Linux 实现独立进程组、`0600` lease、陈旧进程回收和有界 `SIGTERM -> SIGKILL`。
- Rust 监管 desktop-host 及全部后代。
- TS 负责语义化重启；Rust 负责最终回收。
- 保留正常退出、强制关闭、host 崩溃、DSH 崩溃和 WebView 挂起的恢复状态机。

完成标准：

- 不再依赖 `native/supervisor/index.node`。
- Windows/Linux 均无孤儿 host、DSH 或 Extension Host 进程。
- supervisor 单测、跨进程测试和崩溃回收测试通过。

### 阶段 5：实现 Tauri bridge 和插件兼容

任务：

- 将 Electron preload 改造成编译后的 Tauri initialization bridge。
- 继续暴露 `window.dshDesktop`。
- 所有敏感 command 校验窗口标签、当前 URL 和运行期确认的 origin。
- 精确拦截导航、重定向和 `window.open`。
- 外部 HTTP(S) 地址仅交给系统浏览器。
- 文件打开、还原和拖放继续执行 cwd、路径、危险扩展名和真实路径校验。
- 原生拖放事件优先，`getPathForFile` 保留兼容。
- 最大化、余额、恢复状态、服务状态和拖放使用类型化事件。

完成标准：

- 代表插件无需修改即可使用 `window.dshDesktop`。
- balance、file-drop、float-window、plugin-manager 通过 Windows WebView2 和 Linux WebKitGTK 测试。
- 错误 origin、错误窗口、路径越界和危险扩展名全部被拒绝。

### 阶段 6：用户数据和 WebView 状态迁移

任务：

- 保留安装版目录：
  - Windows `%APPDATA%\\Deepseek Harness EAC\\`
  - Linux `~/.config/Deepseek Harness EAC/`
- 保留 Portable 同目录 `data/`。
- 保留 `DSH_DESKTOP_USERDATA` 和 `DSH_HOME` 覆盖语义。
- 不复制或重命名 settings、logs、updates、backups、插件 registry、profile 和 DSH 会话。
- 在最后一个 Electron 版本增加显式 WebView 导出器。
- 迁移文件使用 manifest、版本、checksum 和权限控制。
- 覆盖 localStorage、IndexedDB、cookie 等实际存在的业务数据。
- Tauri 首次启动只导入一次，成功后写完成标记并删除明文迁移文件。
- 浮窗使用隔离存储上下文，并在加载前注入目标 session。

完成标准：

- 干净目录、已有用户目录、Portable 和自定义 DSH_HOME 均能启动。
- 设置、插件状态、会话、日志和 Web UI 持久状态逐项比对一致。
- 未覆盖的数据类型禁止正式切换。

### 阶段 7：Windows Tauri 打包和更新

任务：

- 实现 Tauri NSIS 安装包。
- 实现单文件 Portable 启动器，旁路 `data/`，保持稳定缓存目录。
- 接管旧 Electron 安装目录和 Portable 数据。
- 升级前关闭旧进程并备份 userData、DSH_HOME、profile 和安装目录。
- 保留旧 Setup/Portable 文件名兼容首个 Tauri 版本升级。
- 后续使用 Tauri updater 签名、公钥和 manifest。
- 支持失败回退、启动健康标记和卸载保留数据。
- WebView2、快捷方式、通知、托盘、剪贴板和系统对话框分别测试。

完成标准：

- 旧 Electron 安装版可升级到 Tauri Windows 版。
- 旧 Electron Portable 可迁移到 Tauri Portable。
- 更新失败可回退且不损坏用户数据。
- NSIS、Portable、签名和卸载测试通过。

### 阶段 8：Linux Tauri 打包和更新

任务：

- 从统一 staging tree 生成 deb、rpm、pacman、AppImage。
- 固定 PKGBUILD 和发行版依赖声明。
- 保持包管理器所有权：
  - deb/rpm/pacman 由系统包管理器升级。
  - AppImage 使用独立替换/更新路径。
- 打包 bundled Node/npm、DSH、插件、node-pty、Sharp、Koffi 和许可证。
- 审计权限、桌面文件、图标、ELF、原生模块和 GLIBC。
- Linux 托盘能力允许按环境报告 `supported: false`，不能阻塞无托盘桌面环境。

完成标准：

- 四种归档的应用内容、资源、版本和权限符合预期。
- 所有 ELF `ldd` 无 `not found`。
- GLIBC 最高不超过 2.34。
- bundled Node 24.19.0 可加载 node-pty、Sharp、Koffi 和其他原生模块。
- 安装、升级、卸载和干净 HOME 启动测试通过。

### 阶段 9：双平台 preview 和 Electron 删除

任务：

- Windows CI 构建 NSIS/Portable。
- Linux CI 构建 pacman/deb/rpm/AppImage。
- 同一个 commit 运行 shared TS、RPC、Cargo、clippy 和平台 E2E。
- 发布独立 `tauri-preview` channel。
- 至少两个 preview 版本和连续 14 天观察。
- 阻断级或高严重度回归未清零前不得切正式渠道。
- 正式切换后保留最后一个 Electron tag 和二进制回退。
- 下一稳定版本删除 Electron、electron-builder、Electron preload adapter、N-API 包装层和对应脚本。

## 6. 平台实现要求

### Windows

- WebView2。
- Job Object `KILL_ON_JOB_CLOSE`。
- NSIS 和单文件 Portable。
- Windows 快捷方式、系统托盘、通知和原生对话框。
- `node.exe`、Windows 原生模块和签名资源单独进入 Windows staging。

### Linux

- WebKitGTK。
- process group、lease、启动时陈旧进程回收。
- pacman、deb、rpm、AppImage。
- `node`、Linux 原生模块和可执行权限单独进入 Linux staging。
- 不假设所有桌面环境都有托盘。

### 共同要求

- Tauri command/event 名称一致。
- `window.dshDesktop` API 一致。
- origin、窗口标签和路径安全检查一致。
- 业务错误码、恢复状态和日志字段一致。

## 7. 测试和验收矩阵

共享测试：

- TypeScript typecheck。
- 全量 TS 单测。
- RPC contract。
- 设置迁移、插件、更新和恢复状态机。
- 协议畸形、超限、重复 ID 和错误响应。

Windows 测试：

- WebView2 启动和心跳。
- NSIS 安装、升级、回退、卸载。
- Portable 单 EXE、缓存目录和旁路 data。
- Job Object 进程回收。
- 快捷方式、托盘、通知、剪贴板和文件拖放。

Linux 测试：

- WebKitGTK 启动和心跳。
- deb/rpm/pacman/AppImage 安装和启动。
- POSIX lease 和进程组回收。
- clean HOME、指定 DSH_HOME 和已有配置启动。
- `ldd`、GLIBC、桌面项、权限和原生模块审计。

共同功能验收：

- 34 个桌面桥接能力。
- 主窗和最多 8 个浮窗。
- 向导、更新窗、恢复中心。
- 托盘或无托盘降级。
- balance、file-drop、float-window、plugin-manager 等代表插件。
- 正常退出、强制关闭、host 崩溃、DSH 崩溃、WebView 挂起。
- 外部导航、错误 origin、错误窗口、路径越界和危险扩展名拒绝。

## 8. CI 与发布门禁

每个正式 Tauri commit 必须满足：

```text
Windows runner:
  typecheck + TS tests + Cargo test + clippy
  Tauri build + NSIS + Portable
  upgrade/rollback/clean-user-data E2E

Linux runner:
  typecheck + TS tests + Cargo test + clippy
  Tauri build + pacman/deb/rpm/AppImage
  ldd + glibc + native-module + package audit
  clean-HOME/HTTP/orphan-process E2E
```

发布前必须确认：

- Windows 和 Linux 产物来自同一个 Git commit。
- 版本号、更新 manifest 和 SHA-256 一致。
- 包内没有错误平台的可执行文件或原生模块。
- 未跳过必需的打包、升级、进程回收和数据迁移测试。
- 跳过项必须记录具体原因，不得标记为通过。

## 9. 风险与处理

### 风险：上游持续修改 Electron 壳

处理：

- 只同步共享业务、contract、测试和安全修复。
- Electron 壳改动按行为重新实现。
- 每次同步生成分类报告。

### 风险：Windows/Linux 原生能力不完全一致

处理：

- 对外 contract 保持一致。
- 能力不足时返回明确的 `unsupported`，不伪造成功。
- 托盘、通知和拖放按平台单独验收。

### 风险：Portable 启动器复杂

处理：

- 将 Portable 单列为 Windows P0 验证项。
- 先保证 NSIS 和 Linux 包稳定。
- Portable 未通过时不得删除 Electron fallback。

### 风险：WebView 持久化数据迁移不完整

处理：

- 先清单化 localStorage、IndexedDB、cookie 和业务数据。
- 为每类数据建立导出器、manifest 和校验。
- 发现未覆盖业务数据时暂停正式切换。

### 风险：N-API supervisor 迁移影响进程安全

处理：

- 先保留旧实现作为对照。
- 先完成 Rust 内部模块和独立测试，再切 desktop-host。
- Windows Job Object 和 Linux process group 分别做真实进程测试。

### 风险：上游更新造成 contract 漂移

处理：

- contract 版本化。
- 新字段向后兼容。
- 共享 contract 测试作为合并门禁。

## 10. 工期估算

单人估算：

- 基线和 contract 抽取：4–5 周。
- desktop-host/RPC：3–4 周。
- Tauri workspace 和双平台壳：4–6 周。
- supervisor 迁移：3–4 周。
- 数据迁移和更新：3–4 周。
- 双平台打包、E2E 和原生模块审计：3–5 周。
- preview 和上游同步缓冲：2–4 周。

总计约 20–28 个工程周，另加至少 14 天 preview 观察期。

## 11. 最终完成标准

只有同时满足以下条件，才允许删除 Electron：

1. Windows 和 Linux 在同一个 commit 上均使用 Tauri 壳。
2. shared TypeScript 业务和 contract 通过完整测试。
3. Windows NSIS/Portable 安装、升级、回退和卸载通过。
4. Linux pacman/deb/rpm/AppImage 打包和审计通过。
5. clean HOME、已有用户数据、Portable 和自定义 DSH_HOME 均能返回真实 DSH HTTP 200。
6. 正常退出、强制关闭、host/DSH/WebView 崩溃后无孤儿进程。
7. 原生模块在 bundled Node 24.19.0 下成功导入。
8. 数据迁移逐项比对一致。
9. 至少两个 preview 版本和连续 14 天观察无阻断级或高严重度回归。
10. 最后一个 Electron tag、二进制和回退文档已保存。

最终架构结论：

> 本项目不是维护一个 Linux 私有 fork，而是维护一个同时面向 Windows 和 Linux 的 Tauri 发行版。上游 Electron 只作为业务、协议、插件和安全修复的来源；平台壳由本仓库统一的 Tauri/Rust 架构负责。

## 12. 当前执行记录（2026-08-22）

已完成：

- Tauri/Rust、desktop-host/RPC、bridge、迁移、窗口安全和 Linux lease/process group 基础实现已落地。
- 已重新构建 TypeScript；`npm test` 为 `580 pass, 9 skipped, 0 fail`（589 项），`npm run build` 和 `npm run typecheck` 通过。
- Rust 门禁已重新执行：`cargo fmt --check`、`cargo check`、`cargo test`（10 passed）和 `cargo clippy --all-targets -- -D warnings` 均通过。
- 已修复 clean `DSH_HOME` 下插件依赖闭包不完整导致 `dsh-balance` 无法 load 的问题。启动前会补齐 bundled 插件所需的 fallback links，并修复 dangling/foreign symlink；已有真实目录会保留。
- 已用真实 bundled DSH host 验证 loopback HTTP 200、`dsh-balance` 复制和 patch 登记，插件树可正常加载。
- 已在 Arch Linux 真实 Tauri release 进程上验证：SIGTERM 后 app 退出码为 0，SIGKILL 后退出码为 137；两种场景下 host、DSH、后代进程和 `desktop-host.lease.json` 均回收。
- 为通过上述真实信号门禁，Linux Rust 入口新增了 SIGTERM/SIGINT 监控线程；在进程退出前显式调用 `HostManager::stop()`，补足 Tauri `ExitRequested` 不覆盖外部 OS signal 的路径。

暂缓：

- 不再继续反复构建 deb、rpm、AppImage 或 Windows 包。Arch pacman 包已生成，但当前构建机主二进制引用 `GLIBC_2.39`，不满足 `GLIBC <= 2.34` 门禁；该问题留待独立构建基线处理。

待验证：

- host crash、DSH crash、WebView hang 三类真实 Tauri 场景仍未逐项完成；当前已覆盖正常 host RPC、desktop-host SIGTERM、Tauri SIGTERM 和 Tauri SIGKILL。
- 已执行 desktop-host RPC stdout 关闭后的异步 `EPIPE` 回归，单测通过；仍需在真实 WebView/窗口生命周期中补充异常路径观测。
- Windows WebView2、Portable、签名 updater、真实迁移和至少 14 天 preview 观察仍未完成。
- clean HOME、已有用户数据、Portable、自定义 `DSH_HOME` 的逐项迁移比对仍未完成。
- GLIBC <= 2.34、原生模块完整审计、Linux deb/rpm/pacman/AppImage 全套包审计仍未完成；打包保持暂停。

在上述待验证项完成前，不得将最终完成标准中的 Electron 删除、双平台发布和进程回收门禁标记为通过。
