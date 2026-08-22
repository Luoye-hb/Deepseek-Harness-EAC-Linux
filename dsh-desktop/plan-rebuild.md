# Tauri + Rust + TypeScript 完整重构计划

## 总体目标

将 Electron 桌面壳替换为 Tauri 2，同时保留现有严格 TypeScript 业务架构和 bundled Node 24.19.0 插件生态。

```text
Tauri / Rust 系统壳
    │ typed commands/events
    ▼
TypeScript desktop-host sidecar
    │
    ├── dsh web
    ├── 插件、市场、设置、更新与恢复
    └── Extension Hosts
```

最终交付要求：

- Windows x64：NSIS、单文件 Portable。
- Linux x86_64：pacman、deb、rpm、AppImage。
- 功能对等并经过预览期后删除 Electron。
- 保持现有用户数据、DSH_HOME、插件、设置和升级路径。
- Rust 只承担系统壳、安全边界和进程监管，业务逻辑继续使用严格 TS。
- 不把 Cordis、DSH、插件管理或 Extension Host 重写成 Rust。

## 分阶段实施

### 1. 建立迁移基线

- 从当前提交建立独立 `codex/tauri-migration` 分支，保留 Electron 可运行基线。
- 固化功能对等清单：34 个桌面 IPC、主窗、最多 8 个浮窗、向导、更新窗、恢复中心、托盘、通知、快捷键、拖放、剪贴板和崩溃恢复。
- 保存 Windows、Linux 的启动时间、内存、包体积、HTTP 就绪时间和退出残留进程基线。
- Electron 在迁移期间继续构建，任何阶段都不得以删除旧实现解决适配问题。

### 2. 抽取壳无关 TypeScript 核心

- 将 `DshDesktopApi` 和桌面命令、响应、事件类型迁入共享 contract；保持现有 API 名称和运行行为。
- 将 28 个直接导入 Electron 的 TS 文件拆成业务服务和平台适配器。
- 设置、插件、市场、guard、更新、诊断、profile、会话和 Extension Host 保留在 TS。
- 窗口、托盘、通知、对话框、剪贴板、外链和进程控制改为注入的 `DesktopPlatform` 接口。
- 先提供 Electron adapter，确保抽取完成后 Electron 行为和测试仍完全通过。
- 保持 `strict: true`、`allowJs: false`、Node 24 类型基线和“不跟踪生成 JS”门禁。

### 3. 建立 TypeScript desktop-host

- 新增由 bundled Node 启动的 `desktop-host` 入口，承载原 Electron main 中的 TS 业务装配。
- 复用现有 4 MB 长度前缀 RPC：`req`、`res`、`notify`；stdout 只传协议帧，日志进入 stderr 和原日志文件。
- 为所有方法定义判别联合参数与响应，错误统一为 `{ code, message, retryable, details? }`。
- 普通请求默认 15 秒超时，安装、更新和日志导出类请求使用显式长任务事件，不占用无限等待请求。
- 协议畸形、超限、重复 ID 或 sidecar 退出时由 Rust 中止连接、记录事故并进入恢复流程。
- Node host 不开放 TCP 管理端口；Tauri 与 host 只走父子进程 stdio。

### 4. 建立 Tauri/Rust 系统壳

- 新增 Tauri 2 workspace，固定 Cargo.lock；整合现有 Rust supervisor，不再通过 N-API 调用。
- Rust 管理单实例、窗口、托盘、通知、对话框、剪贴板、文件/URL 打开和系统终端。
- Windows 使用 Job Object `KILL_ON_JOB_CLOSE`；Linux 使用独立进程组、`0600` lease、启动时陈旧进程回收以及有界 `SIGTERM -> SIGKILL`。
- Rust 启动 desktop-host，并将其全部后代纳入同一监管边界；TS 负责语义化重启，Rust 负责最终回收。
- 启动时先显示本地 loading 页面；host 报告 URL 后，Rust 再次验证回环地址和 HTTP 200，再加载 DSH Web UI。
- sidecar 崩溃、DSH 停止、HTTP 假就绪、WebView 心跳超时分别进入现有恢复状态机对应分支。
- 实现主窗、浮窗、向导、更新窗和恢复中心；窗口标签固定并用于命令授权。

### 5. 实现安全桥与插件兼容

- 将 preload 改造成编译后的 Tauri initialization bridge，继续暴露 `window.dshDesktop`。
- 页面不得获得通用 Tauri shell、fs、process API；每个敏感 command 均校验窗口标签和当前 URL 必须等于运行期确认的 `127.0.0.1:<port>` origin。
- 导航、重定向和 `window.open` 继续采用精确 origin 比较，外部 HTTP(S) 地址只交给系统浏览器。
- 文件打开、还原和拖放继续经过会话 cwd、危险扩展名及真实路径校验。
- 保留 `getPathForFile(file)`：桥只允许从当前原生拖放事务缓存中按顺序解析路径，事务结束即清空。
- 新增 `files.onDrop(callback)` 类型化 API，内置 file-drop 插件优先使用原生路径事件；旧插件继续通过兼容方法工作。
- 最大化、余额、恢复状态、服务状态和拖放使用类型化 Tauri events，取消页面对原始 channel 名的依赖。

### 6. 用户数据和 WebView 状态迁移

- 安装版继续使用原目录：Windows `%APPDATA%\Deepseek Harness EAC\`，Linux `~/.config/Deepseek Harness EAC/`。
- Portable 继续使用启动器同目录的 `data/`；保留 `DSH_DESKTOP_USERDATA` 和 `DSH_HOME` 覆盖语义。
- 不复制或重命名现有 settings、日志、updates、backups、插件 registry、profile 和 DSH 会话。
- 发布最后一个 Electron 过渡版本，将 DSH origin 的持久化 localStorage 导出到权限为 `0600` 的迁移文件。
- Tauri 首次启动在加载 Web UI 前导入一次，校验成功后写完成标记并删除明文迁移文件。
- 对 IndexedDB、cookie 和其他持久化存储做清单；存在业务数据时增加对应导出器，存在未覆盖数据时禁止正式切换。
- 浮窗使用隔离的 WebView 存储上下文，并在加载前注入目标 session，确保不覆盖主窗选中态。

### 7. 打包与更新迁移

- 资源包继续包含 Node/npm、DSH、当前内置插件、node-pty、Sharp、Koffi 和许可证。
- Windows NSIS 使用 Tauri 自定义模板，迁移旧安装目录接管、进程关闭、快捷方式、卸载保留数据及回滚行为。
- Windows Portable 使用自定义 NSIS 自解压启动器，保持单 EXE、稳定缓存目录、旁路 `data/` 和原资产命名。
- Linux 使用 Tauri 生成 deb/rpm/AppImage；pacman 从同一 staging tree 通过固定 PKGBUILD 生成，四种包内容必须一致。
- 第一个 Tauri 正式版继续使用旧 Electron 更新器能识别的 Setup/Portable 文件名，使现有用户可原地升级。
- 从该版本开始发布 Tauri updater 签名、更新 manifest 和 `.sig`；私钥只存 CI secret，客户端只内置公钥。
- Windows 后续使用签名更新；Linux 保持包管理器所有权，AppImage 继续手动替换。
- 更新前继续备份 userData、DSH_HOME、profile 和安装目录；启动健康标记未写入时执行自动回退。

### 8. CI、预览和 Electron 删除

- Windows CI 构建 NSIS/Portable；Linux 在 Debian 12 构建并审计四种包。
- 两个平台分别运行 TS 测试、typecheck、Cargo test、clippy、RPC contract 和 Tauri WebDriver E2E。
- 发布独立 `tauri-preview` 渠道，不覆盖稳定 Electron 资产。
- 至少完成两个 preview 版本和连续 14 天验证；期间不得存在未解决的阻断级或高严重度回归。
- 门禁通过后，正式渠道切到 Tauri，并保留最后一个 Electron tag 和二进制作为回退。
- 下一稳定版本删除 Electron、electron-builder、preload Electron adapter、N-API 包装层和对应构建脚本；Rust supervisor 实现保留在 Tauri workspace。
- 更新 README、支持矩阵、架构 ADR、开发命令、发布说明和故障恢复文档。

## 公共接口变化

- `window.dshDesktop` 现有字段、方法名和返回语义保持兼容。
- `ChromeInfo` 增加可选 `desktopShell: 'electron' | 'tauri'`，供诊断显示，不用于功能分支。
- 新增 `files.onDrop(callback)`；旧 `getPathForFile(file)` 保留。
- 内部新增 `DesktopHostRequest`、`DesktopHostResponse`、`DesktopHostEvent` 和结构化错误类型。
- 不对页面暴露通用 Rust/Tauri IPC、任意文件系统能力或任意进程执行能力。

## 测试与验收

- 启动：干净 HOME/AppData、已有用户目录、Portable、指定 DSH_HOME 均能返回真实 DSH HTTP 200。
- 功能：34 个桥接能力、窗口/浮窗、托盘、通知、向导、恢复、插件管理、更新、文件操作逐项对等。
- WebView：真实 DSH Web UI 及 balance、file-drop、float-window、plugin-manager 等代表插件在 WebKitGTK 和 WebView2 下通过。
- 生命周期：正常退出、强制关闭、host 崩溃、DSH 崩溃、WebView 挂起和陈旧 lease 后均无孤儿进程。
- 安全：错误 origin、错误窗口、外部导航、路径越界、危险扩展名、畸形或超限 RPC 全部被拒绝并留日志。
- 原生模块：成品内使用 bundled Node 24.19.0 成功导入 node-pty、Sharp、Koffi 和其他保留的原生依赖。
- Linux：所有 ELF `ldd` 无 `not found`，GLIBC 不高于 2.34，四种归档的元数据、权限、桌面项和资源审计通过。
- Windows：旧 Electron 安装版和 Portable 均可升级到首个 Tauri 版；签名更新、失败回退、卸载保留数据均通过。
- 数据：设置、插件状态、会话、更新 overlay、日志和 Web UI 持久状态在迁移前后逐项比对一致。

## 工期与默认假设

- 单人预计 14-20 个工程周，另含至少 14 天 preview 观察期；协议、平台壳和打包可并行缩短日历时间。
- 只交付 Windows/Linux x64，不增加 macOS、ARM 或移动端。
- 不改变 DSH、Cordis、插件 SDK 和用户配置格式。
- 包体积优化是迁移收益，但不以删除 Node/npm、原生模块或插件资源换取体积。
- 任一平台未通过完整打包、升级、WebView、进程回收和原生模块门禁时，都不得删除 Electron。
