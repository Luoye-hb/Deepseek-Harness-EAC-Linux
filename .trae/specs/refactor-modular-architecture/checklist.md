# Checklist

## 分支与安全网
- [ ] `refactor/vnext-ts-isolation` 分支已创建并基于重构前 HEAD
- [ ] 基线记录：457 测试通过、check-syntax 通过
- [ ] `extract-css.mjs` 已删除且全量测试仍绿
- [ ] 用户未提交的 package-lock.json 改动未被回滚、未混入重构提交

## TypeScript 全面迁移
- [ ] tsconfig strict（+noUncheckedIndexedAccess/exactOptionalPropertyTypes）落地，`npm run typecheck` 零错误
- [ ] `npm run build`（tsc → dist）可用；package.json main → dist/main.js；start/pack/dist 前置构建
- [ ] 全部自有 `.js/.mjs` 源迁移为 `.ts`（含 scripts 与 57 个测试），结束态 allowJs:false、仓库无自有 JS 源
- [ ] 协议/IPC/SDK/注册表类型单点定义于 `shared/protocol.ts`，边界无 `any` 逃逸
- [ ] 运行时（Electron/内置 node.exe）仅执行 dist 编译产物
- [ ] check-syntax 适配 TS 源 + dist 产物；bundled-files 改为解析 main.ts import 映射 dist 核对 builder 清单

## 模块化基础
- [ ] `main.ts` < 400 行，仅装配/接线
- [ ] 无自有源码文件 > 600 行（vendor/dist/assets 除外）
- [ ] `lib/state.ts` 强类型集中共享状态，语义与原闭包一一对应
- [x] 大文件门面拆分后原 import 路径全部可用（client-updater 17 导出 / logger _testExports / plugin-guard createGuard+GUARD_FILES / preload.js 编译产物路径全部不变）
- [ ] 每个新模块有文件头职责注释，非自明函数有中文注释
- [x] 源码文本断言测试已指向新模块且语义等价（titlebar-strip→preload/chrome.js、recovery-integration→preload/api.ts）

## Phase 0 稳定面
- [ ] 恢复中心窗口不依赖 dsh web，托盘/启动失败/DSH_DESKTOP_RECOVERY=1 三入口可达
- [ ] 恢复中心可停用/卸载/回滚/隔离插件、看日志与事故、导出诊断包、安全模式启动
- [ ] 每个已装插件有来源/风险等级/最近启动失败档案
- [ ] 市场插件覆盖内置组件被拦截并记录（测试固化）

## Phase 1 配置分离
- [ ] `<DSH_HOME>/extensions/registry.json` 注册表落地，含状态机全部字段
- [ ] 故障状态机：退避重试、连续失败自动隔离、解除隔离重试，全部转移写事故记录
- [ ] SDK 插件原子安装（临时目录→SHA-256→原子切换），失败自动回退
- [ ] SDK 插件安装/更新/回滚后 Core Profile 依赖图零变化（测试断言）
- [ ] Legacy 插件行为不变且登记为 legacy 类型 + 风险等级

## Phase 2 隔离宿主与 SDK
- [x] 每个启用 SDK 插件运行于独立 Node 子进程（host-bootstrap 编译产物）
- [x] JSON-RPC over stdio：长度前缀帧、请求关联、调用级严格超时
- [x] 心跳超时检测 + 崩溃退避重启 + 超阈值自动隔离
- [x] **Rust Job Object 围栏（native/supervisor，napi-rs）**：KILL_ON_JOB_CLOSE + 每插件内存上限，Supervisor 崩溃无孤儿进程（driver 子进程测试验证，含孙进程整树回收）。实现为「Node spawn 持有 stdio + Rust assign_to_job」混合围栏（Node 26 libuv 已弃用 CRT fd 表，纯原生管道无法交还 Node 流）；spawn→assign 毫秒级窗口由 init 握手协议闭合（此前不载插件代码），安全效果与原子 spawn-into-job 等价
- [x] Rust 模块工程质量：`cargo clippy -D warnings` 零告警、`cargo test` 通过（10 项）；缺模块时优雅降级（警告 + taskkill 树回收，端到端测试）
- [x] 预编译 `.node` 入包并在 predist 强制校验存在
- [x] 权限门 deny-by-default：net/fs/shell/env 未授权即不可见（SDK 面无该 API），授权状态入注册表并经 listRegistryEntries 下发恢复中心
- [x] SDK V1：工具注册（参数描述符校验）/事件订阅/上下文注入/设置命名空间/日志/心跳
- [x] Core Bridge 桥接工具到 Agent；扩展超时/异常→记录+熔断+继续回合（上下文超时丢弃返回原 assembly；工具失败返回错误文本）
- [x] 示例 SDK 插件（sample-sdk-plugin，含 echo/status 工具 + 上下文 + 设置 + 事件）随仓库分发并纳入打包（伴生插件整体迁移属 Phase 3 外置 UI，见 tasks.md 11.4 说明）
- [x] 故障注入：kill -9/死循环/不回包 → 核心不中断（进程隔离 + 独立测试进程验证）、状态机正确流转（9 项故障注入测试）

## 性能专项
- [ ] `scripts/bench-boot.ts` 基线与改造后对比数据留档，冷启动不劣化
- [ ] 启动扫描缓存、并行拉起、懒加载、日志异步管线落地
- [ ] Rust 原生热路径（spawn-into-job/配额/流式 SHA-256）落地并被 installer/manager 复用

## 工程质量
- [ ] 每个里程碑独立 git commit 且提交时点测试全绿 + typecheck 零错
- [ ] `npm test` 全绿（457+ pass，含新增测试）
- [ ] `cargo clippy`/`cargo test` 通过（Rust 模块）
- [ ] `npm run pack` 打包成功，bundled-files 测试绿
- [ ] 架构文档 §10 验收标准 1-6 有可重复执行的核验测试
- [ ] checklist 全勾并最终提交
