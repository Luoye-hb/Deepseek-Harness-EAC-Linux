'use strict';

// DSH Desktop — Electron shell around the DeepSeek Harness browser UI.
//
// What it does:
//   1. Boots the bundled dsh CLI ("dsh web") with a standalone Node runtime.
//   2. Waits until the web UI answers HTTP on 127.0.0.1:<free-port>.
//   3. Shows it in a native window; quits the server when the app exits.
//   4. Checks for official @deepseek-ai/dsh releases and, with the user's
//      consent, self-updates the agent (see updater.js).
//
// The dsh CLI is spawned with the bundled node.exe (vendor/node/node.exe in
// dev, resources/node/node.exe when packaged) so that prebuilt native
// modules (sharp, node-pty, koffi, ...) match the Node ABI they were
// installed for. We deliberately never rebuild them against Electron.

const { app, BrowserWindow, Menu, Tray, shell, dialog, Notification, ipcMain, clipboard } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const updater = require('./updater');
const clientUpdater = require('./client-updater');
const pluginUpdater = require('./plugin-updater');
const structuredLogger = require('./logger');
const balance = require('./balance');
const { healProfileModuleShadowing } = require('./profile-module-heal');
const { createGuard } = require('./plugin-guard');
const bundleIntegrity = require('./bundle-integrity');
const { RendererRecovery } = require('./renderer-recovery');
const { restrictedPortOf, chooseStableWebPort } = require('./stable-port');
const {
  runKoffiPreflight,
  runKoffiPreflightAsync,
  enablePickerBrowseOverlay,
  clearAutoPickerBrowseOverlay,
} = require('./koffi-preflight');
const { configLinesFor, healSoulMdPatchRow, healRowConfig, removeBundledRowDuplicates, collectBundleEntryIds } = require('./patch-row-heal');
const { syncBundledPresets, ensureDefaultAgentPreset } = require('./preset-sync');
const { buildErrorDetail } = require('./error-detail');
const { SessionWatcher } = require('./session-watcher');
const { isEncodingMismatch, healSessionEncodingConflicts } = require('./session-encoding-heal');
const { patchSessionManage } = require('./scripts/patch-session-manage');
const { togglePluginInPatch, removePluginFromPatch, hasEntryId } = require('./scripts/plugin-manager-patch');
const { collectPluginRows } = require('./plugin-manager-state');
const onboardingLogic = require('./scripts/onboarding');
// 全局共享可变状态单例（Task 1.1 迁自本文件顶层声明）；lib/*.js 均为
// `npm run build` 的 tsc 原地编译产物，见 .gitignore。
const { state } = require('./lib/state.js');
// Task 1.x 提取的单一职责模块：统一日志通道 / 运行时定位与进程回收 /
// 路径围栏与 profile 解析。
const { log } = require('./lib/log.js');
const {
  IS_WIN, nodeExe, npmCli, updCtx, dshBin, dshVersion, dshVersionSource,
  killTree, killTreeAndWait, waitForProcExit,
} = require('./lib/proc.js');
const {
  DANGEROUS_EXT, fileRoots, isUnderFileRoots,
  DESKTOP_PROFILE, DESKTOP_PROFILE_BUNDLES,
  desktopProfile, desktopProfileDir, ensureDesktopProfileInit,
  profileDirFor, artifactCacheDirFor,
} = require('./lib/paths.js');
// Task 2 提取的模块：跨域注入点 / 运行状态 / 看门狗 / 服务生命周期 /
// 内置终端 / 预览静态服务 / 市场插件 ESM 加载器。
const { bridge } = require('./lib/bridge.js');
const {
  writeRunState, markCleanExit, detectUncleanPreviousRun, notifyUncleanRestart,
  autoRollbackClientIfCrashed, cleanupClientBackupIfHealthy, offerBackupCleanupConfirm,
} = require('./lib/run-state.js');
const { startWatchdog, startJunctionWatchdog } = require('./lib/watchdog-boot.js');
const {
  childEnv, startAndShow, startAndShowGuarded, restartWebServiceCore,
} = require('./lib/server.js');
const { openBuiltinTerminal } = require('./lib/terminal.js');
const { startPreviewStaticServer } = require('./lib/preview.js');
const { artifactKeep, allowBuilds } = require('./lib/market-modules.js');
// Task 3 提取的模块：窗口族（含渲染自恢复装配）与托盘/退出策略。
const {
  showBox, isAllowedWebUrl, createWindow, createFloatWindow, closeAllFloatWindows,
  reloadMainWindow, initRendererRecovery, startHeartbeatLoop,
} = require('./lib/window.js');
const {
  showMainWindow, createTray, trayHintOnce, closeToTrayEnabled, setCloseToTray,
  getExitAction, setExitAction, askExitAction, showAbout, repoUrls,
} = require('./lib/tray.js');
// Task 5 提取的模块：插件同步/复制/清单/管理/市场任务/迁移/运行时补丁。
const { COMPANION_PLUGINS, pluginUpdateSources, builtinPluginSourceDir } = require('./lib/plugin-registry-data.js');
const { readJsonFile, copyPluginPackage } = require('./lib/plugin-copy.js');
const { SKINS_DIR, healProfileModules, managedPackageNames, restoreKeptArtifacts, syncBundledSkills, syncCompanionPlugins } = require('./lib/plugins.js');
const {
  loadDshYamlDialect: _loadDshYamlDialect, pluginManagerReadPatch: _pluginManagerReadPatch,
  pluginManagerPackageDescription, pluginManagerCollect, pluginManagerResolveName,
  removedPluginIds, saveRemovedPluginIds: _saveRemovedPluginIds, restoreCompanionPlugin: _restoreCompanionPlugin,
  pluginManagerSetRemoved, pluginManagerSetEnabled, imagePasteSave,
} = require('./lib/plugin-manager-core.js');
const { processPendingMarketOps } = require('./lib/market-ops.js');
const { warnTempRun, migrateFromSharedWebProfile, extractPatchRowIds, removePatchRowsById, applyLegacySkinChoice } = require('./lib/migration.js');
const { applySessionManageFix } = require('./lib/session-heal.js');
// bridge 更新：plugins 域函数已迁入 lib，装配指向新模块导出。
bridge.processPendingMarketOps = processPendingMarketOps;
bridge.syncCompanionPlugins = syncCompanionPlugins;
bridge.healProfileModules = healProfileModules;
bridge.restoreKeptArtifacts = restoreKeptArtifacts;
// bridge 更新：窗口/托盘函数已迁入 lib，装配指向新模块导出。
bridge.showMainWindow = showMainWindow;
bridge.showBox = showBox;
bridge.getExitAction = getExitAction;
bridge.askExitAction = askExitAction;
bridge.trayHintOnce = trayHintOnce;
// 跨域注入点装配（lib/bridge.ts）：函数声明提升，此处顶层引用安全。
bridge.ensureGuard = ensureGuard;
bridge.handleBootFailure = handleBootFailure;

const APP_VERSION = app.getVersion();
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// 顶层共享可变状态（原为一批顶层 let/const：mainWindow/serverProc/webUrl/…，
// 含浮窗表、恢复状态机、托盘等）已迁移至 lib/state.ts 强类型单例（Task 1.1），
// 本文件统一经 `state.xxx` 读写；纯常量（FLOAT_MAX 等）仍留在本文件。
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// 插件保护中心（plugin-guard.js）：快照 / 回滚 / 静态体检 / 自动修复 /
// 守护启动 / 事故报告。实例延迟创建（依赖 dshHome 与 settings 就绪）。
// ---------------------------------------------------------------------------
function ensureGuard() {
  if (!state.guardInstance) {
    state.guardInstance = createGuard({
      getHome: () => state.dshHome || path.join(os.homedir(), '.dsh'),
      getProfile: () => desktopProfile(),
      dshBin: () => dshBin(),
      log,
    });
  }
  return state.guardInstance;
}







// ---------------------------------------------------------------------------
// koffi 预检与目录选择器降级（koffi-preflight.js）：koffi 3.1.3/3.1.4 的
// win32-x64 预编译二进制在部分 Windows 机器上会在 load 时原生崩溃
// （0xC0000005），目录选择器 worker 无消息退出。启动前用内置 node 在子
// 进程里做一次 FFI 冒烟；失败则注入 browse 后端 overlay。
// ---------------------------------------------------------------------------
function pickerBrowseOverlayPath() {
  return path.join(state.userDataDir, 'picker-browse.overlay.yml');
}

function preflightLogger(msg) {
  log('preflight', msg);
}

function applyKoffiPreflight() {
  const file = pickerBrowseOverlayPath();
  const ok = runKoffiPreflight({
    spawnSync,
    nodeExe: nodeExe(),
    script: path.join(__dirname, 'scripts', 'koffi-preflight.cjs'),
    log: preflightLogger,
  });
  if (ok) {
    clearAutoPickerBrowseOverlay({ file, log: preflightLogger });
    state.pickerBrowseOverlay = null;
  } else {
    state.pickerBrowseOverlay = enablePickerBrowseOverlay({ file, log: preflightLogger });
  }
  return ok;
}

// V4：异步版（spawn 而非 spawnSync）—— 同步探针会把主进程事件循环卡住
// 最长 20 秒（托盘/菜单/IPC 全无响应）。boot 链改走这里，语义不变。
function applyKoffiPreflightAsync() {
  const file = pickerBrowseOverlayPath();
  return runKoffiPreflightAsync({
    spawn,
    nodeExe: nodeExe(),
    script: path.join(__dirname, 'scripts', 'koffi-preflight.cjs'),
    log: preflightLogger,
  }).then((ok) => {
    if (ok) {
      clearAutoPickerBrowseOverlay({ file, log: preflightLogger });
      state.pickerBrowseOverlay = null;
    } else {
      state.pickerBrowseOverlay = enablePickerBrowseOverlay({ file, log: preflightLogger });
    }
    return ok;
  });
}

function handleBootFailure(err) {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) {
    // V4.1 更新保障②：上次更新保留的上一版本备份可用时，优先提供
    // 「回退到上一版本」（比退回内置版更贴近用户原状态）。
    const prev = updater.previousAgentInfo(updCtx());
    // V4.2 插件即时提醒：报错文案归因到 profile 里的插件时，提供
    // 「停用插件 X 并重试」（写盘停用，重启不还原）；另有最后良好快照时
    // 提供「回滚到最后良好快照并重试」。两项都失败才轮到版本级回退。
    let blame = null;
    let blameRow = null;
    try {
      const g = ensureGuard();
      if (typeof g.attributeBootFailure === 'function') {
        blame = g.attributeBootFailure(String((err && err.message) || err));
      }
      if (blame) {
        try {
          blameRow = pluginManagerCollect().find((r) => r.id === blame.rowId) || null;
        } catch { blameRow = null; }
      }
    } catch {}
    const lastGood = (() => { try { return ensureGuard().lastGoodSnapshot(); } catch { return null; } })();
    const btnDisable = blameRow && blameRow.toggleable ? '停用插件 ' + blameRow.name + ' 并重试' : null;
    const btnRollback = lastGood ? '回滚到最后良好快照并重试' : null;
    const buttons = [
      ...(btnDisable ? [btnDisable] : []),
      ...(btnRollback ? [btnRollback] : []),
      ...(prev ? ['回退到上一版本并重试', '回退到内置版本', '重试', '退出'] : ['回退到内置版本并重试', '重试', '退出']),
    ];
    const detailLines = [String((err && err.message) || err)];
    if (blame) {
      detailLines.push('', `报错指向插件「${blame.name}」（${blame.kind === 'patchRow' ? 'patch 行 ' + blame.rowId : blame.kind}），可先停用该插件后重试。`);
    }
    if (lastGood) {
      detailLines.push(`存在最后良好快照（${lastGood.reason || lastGood.id}），可一键回滚后重试。`);
    }
    if (prev) detailLines.push('', `可回退到上一版本（v${prev.version}）或内置版本继续使用。`);
    else detailLines.push('', '可回退到内置版本继续使用。');
    showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: prev ? '更新后的 agent 无法启动。' : 'DeepSeek Harness 无法启动。',
      detail: detailLines.join('\n'),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    }).then(({ response }) => {
      let i = 0;
      const take = () => i++;
      // 归因到插件时，优先给「停用插件」——
      if (btnDisable && response === take()) {
        try {
          pluginManagerSetEnabled(blameRow.id, false);
          log('plugin-manager', `启动失败后停用插件: ${blameRow.id}`);
        } catch (e2) { log('plugin-manager', '停用插件失败: ' + ((e2 && e2.message) || e2)); }
        startAndShow().catch((e2) => handleBootFailure(e2));
        return;
      }
      if (btnRollback && response === take()) {
        try {
          ensureGuard().restore(lastGood.id);
        } catch (e2) { log('guard', '回滚快照失败: ' + ((e2 && e2.message) || e2)); }
        startAndShow().catch((e2) => handleBootFailure(e2));
        return;
      }
      if (prev && response === take()) {
        updater.rollbackToPrevious(updCtx());
        startAndShow().catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
      } else if ((prev && response === take()) || (!prev && response === take())) {
        updater.rollback(updCtx());
        startAndShow().catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
      } else if ((prev && response === take()) || (!prev && response === take())) {
        startAndShow().catch((e2) => handleBootFailure(e2));
      } else {
        app.quit();
      }
    });
  } else {
    fatal('Deepseek Harness 启动失败', err);
  }
  // dsh web 起不来（如 v3.0.0 schemastery 闭包缺陷）的用户永远走不到
  // 成功链上的自动更新定时器，只能手动重装。主动查一次客户端更新，
  // manual=true 绕过 skip/稍后 抑制，让修复版本能下载并自愈。
  scheduleClientUpdateRescue();
}

// 启动失败救援（防重入）：一次会话只主动查一次，避免与用户的重试操作
// 互相干扰；网络失败不打扰（runClientUpdateFlow 的 manual 弹窗已够）。
function scheduleClientUpdateRescue() {
  if (state.clientUpdateRescueArmed || process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE) return;
  state.clientUpdateRescueArmed = true;
  setTimeout(() => {
    runClientUpdateFlow(true).catch((e) => log('client-update', '救援检查失败: ' + e.message));
  }, 5000).unref();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 内置插件选择向导（首次启动 first 模式 / 设置页二次打开 rerun 模式）
// ---------------------------------------------------------------------------

function closeWizard(result) {
  const cb = state.wizardDone;
  state.wizardDone = null;
  if (state.wizardWindow && !state.wizardWindow.isDestroyed()) state.wizardWindow.destroy();
  state.wizardWindow = null;
  if (cb) cb(result);
}

// 包目录体积（递归字节数，带缓存）。首次同步前 assets 尚未落盘到 profile，
// 以分发目录为准展示体积提示。
const pluginDirSizeCache = new Map();
function pluginDirSize(dirName) {
  if (pluginDirSizeCache.has(dirName)) return pluginDirSizeCache.get(dirName);
  let total = 0;
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      }
    };
    walk(path.join(__dirname, 'assets', 'plugins', dirName));
  } catch {}
  pluginDirSizeCache.set(dirName, total);
  return total;
}

// 向导目录：核心/推荐标记 + 描述 + 包体积（数据来源与 sync 保持一致）。
function buildOnboardingCatalog() {
  return onboardingLogic.buildCatalog(COMPANION_PLUGINS, {
    coreIds: onboardingLogic.CORE_PLUGIN_IDS,
    recommendedIds: onboardingLogic.RECOMMENDED_PLUGIN_IDS,
    describe: (name) => pluginManagerPackageDescription(name),
    dirSize: (dirName) => pluginDirSize(dirName),
  });
}

// patch + 注册表 → 各内置插件当前启用状态（rerun 模式预填勾选用）。
function pluginCurrentState() {
  const { entries } = pluginManagerReadPatch();
  return onboardingLogic.pluginCurrentState(entries, COMPANION_PLUGINS);
}

// 打开向导窗口。返回 Promise：提交（{ok:true, applied, errors}）或关闭
// （{ok:false, cancelled:true}）时 resolve；窗口已存在时聚焦并直接 resolve。
function openPluginWizard({ mode = 'first' } = {}) {
  return new Promise((resolve) => {
    if (state.wizardWindow && !state.wizardWindow.isDestroyed()) {
      state.wizardWindow.focus();
      resolve({ ok: false, cancelled: true });
      return;
    }
    state.wizardMode = mode === 'rerun' ? 'rerun' : 'first';
    state.wizardDone = resolve;
    const win = new BrowserWindow({
      width: 920,
      height: 700,
      minWidth: 640,
      minHeight: 520,
      show: false,
      title: '内置插件选择向导',
      backgroundColor: '#0b1220',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'assets', 'onboarding-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    state.wizardWindow = win;
    win.loadFile(path.join(__dirname, 'assets', 'onboarding.html'));
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.on('closed', () => {
      const cb = state.wizardDone;
      state.wizardDone = null;
      state.wizardWindow = null;
      if (cb) cb({ ok: false, cancelled: true });
    });
    log('boot', '已打开内置插件选择向导（' + state.wizardMode + ' 模式）');
  });
}

// 启动门控：全新用户展示向导并等待提交；升级用户静默跳过并记完成标记。
// 关闭向导（取消）= 保持全部启用（等价老用户现状），只记完成标记不再打扰。
// onboardingNeeded 必须在任何写盘之前由 computeOnboardingNeed 预计算：
// settings.json 会在启动早期被迁移流程无条件创建，事后无法区分新老用户。
async function runPluginOnboardingIfNeeded(onboardingNeeded) {
  if (!onboardingNeeded) {
    const settings = updater.loadSettings(updCtx());
    if (!settings.pluginOnboardingDone) {
      settings.pluginOnboardingDone = true;
      updater.saveSettings(updCtx(), settings);
      log('boot', '升级用户：跳过插件选择向导，插件保持全量现状');
    }
    return { ran: false };
  }
  log('boot', '全新用户：展示内置插件选择向导');
  const result = await openPluginWizard({ mode: 'first' });
  if (!result.ok) {
    const s = updater.loadSettings(updCtx());
    s.pluginOnboardingDone = true;
    updater.saveSettings(updCtx(), s);
    log('boot', '用户关闭插件选择向导：保持全部插件启用');
  }
  return { ran: true, ...result };
}



function fatal(title, err) {
  log('fatal', title + ': ' + ((err && (err.stack || err.message)) || err));
  const detail = buildErrorDetail(err, state.logsDir, ['dsh-web.log', 'desktop.log']);
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    dialog.showMessageBox({
      type: 'error',
      title,
      message: title,
      detail,
      buttons: ['复制日志', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) clipboard.writeText(detail);
      markCleanExit(); // 启动失败属已知退出：避免看门狗反复拉起反复失败
      app.exit(1);
    });
    return;
  }
  showBox({
    type: 'error',
    title,
    message: title,
    detail,
    buttons: ['复制日志', '重试', '退出'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) clipboard.writeText(detail);
    else if (response === 1) startAndShow().catch((err2) => handleBootFailure(err2));
    else app.quit();
  });
}

// ---------------------------------------------------------------------------
// Self-update flow (official @deepseek-ai/dsh releases, user-consented)
// ---------------------------------------------------------------------------

function showUpdateWindow(version, kind = 'agent') {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined,
    modal: true,
    title: '正在更新',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'assets', 'updating.html')).then(() => {
    win.webContents
      .executeJavaScript(`window.__init && window.__init(${JSON.stringify({ version, kind })})`)
      .catch(() => {});
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

// 更新弹窗进度推送（agent / client 共用）：把结构化进度渲染成文案，节流后
// 注入 updating.html 的 __setProgress(pct, receivedMB, totalMB, meta)。
// meta = { stage, speedMBps, etaSec } —— stage 为文案时进度条走不定态。
function makeUpdateProgressPusher(win) {
  let last = 0;
  const hostOf = (registry) => {
    try { return String(registry || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''); } catch { return ''; }
  };
  const push = (payload) => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    if (now - last < 300 && !payload.force) return;
    last = now;
    const meta = payload.meta || {};
    win.webContents
      .executeJavaScript(
        `window.__setProgress && window.__setProgress(${payload.pct}, ${payload.receivedMB || 0}, ${payload.totalMB || 0}, ${JSON.stringify(meta)})`
      )
      .catch(() => {});
  };
  return {
    // 客户端更新：真实字节进度 + 速度 + 剩余时间（meta 可选追加）。
    client: (received, total, meta) => {
      const pct = total > 0 ? Math.round((received * 100) / total) : -1;
      push({ pct, receivedMB: Math.round(received / 1048576), totalMB: Math.round(total / 1048576), meta });
    },
    force: (meta) => push({ pct: -1, meta, force: true }),
    // agent 更新：npm 阶段/包数/耗时 + 镜像源切换
    agent: (ev) => {
      let stage;
      if (ev.stage === 'fetch') {
        stage = `下载依赖 · 已获取 ${ev.count || 0} 项 · 用时 ${ev.elapsed || ''}` + (ev.registry ? ' · 源：' + hostOf(ev.registry) : '');
      } else if (ev.stage === 'install') {
        stage = '正在安装依赖…';
      } else if (ev.stage === 'done') {
        stage = '安装完成，正在切换版本…';
      } else if (ev.stage === 'mirror') {
        stage = ev.registry ? '下载停滞，已自动切换镜像源：' + hostOf(ev.registry) : '下载失败，正在尝试其他镜像源…';
      } else {
        stage = '正在更新…';
      }
      push({ pct: -1, meta: { stage } });
    },
  };
}

async function runUpdateFlow(manual) {
  if (state.quitting) return;
  if (state.updateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  let latest;
  try {
    latest = await updater.checkLatest(ctx);
  } catch (err) {
    log('update', '检查失败: ' + err.message);
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查更新失败',
        message: '无法连接 npm registry。',
        detail: err.message + '\n\n可通过环境变量 NPM_CONFIG_REGISTRY 配置镜像。',
        buttons: ['确定'],
      });
    }
    return;
  }
  const current = updater.activeVersion(ctx);
  const settings = updater.loadSettings(ctx);
  if (updater.compareVersions(latest, current) <= 0) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查更新',
        message: '当前已是最新版本。',
        detail: `@deepseek-ai/dsh@${current}`,
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!manual && settings.skipVersion === latest) return;

  const { response } = await showBox({
    type: 'info',
    title: '发现新版本',
    message: `官方 @deepseek-ai/dsh 发布了新版本：${latest}`,
    detail: `当前版本：${current}\n\n是否立即更新？\n· 从 npm 官方源下载新版本及其依赖（首次约 250MB）\n· 更新期间界面保持可用，完成后重启应用生效\n· 失败会自动保留当前版本`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipVersion = latest;
    updater.saveSettings(ctx, settings);
    log('update', '用户跳过版本 ' + latest);
    return;
  }
  if (response === 2) return;

  state.updateBusy = true;
  const progressWin = showUpdateWindow(latest);
  const progress = makeUpdateProgressPusher(progressWin);
  try {
    // V4.1 更新保障①：更新前强制插件/配置快照，失败则中止更新
    //（宁可不动，不可让用户失去回滚点）。
    const snap = ensureGuard().snapshot('pre-update:dsh:' + latest);
    if (!snap) {
      throw new Error('更新前保护快照失败（profile 不可读），已中止更新以保证可回滚。');
    }
    await updater.applyUpdate(ctx, latest, { onProgress: (ev) => progress.agent(ev) });
    const { response: r2 } = await showBox({
      type: 'info',
      title: '更新完成',
      message: `已更新到 @deepseek-ai/dsh@${latest}`,
      detail: '重启应用后生效。\n· 插件、皮肤与配置均保留在 profile，不受更新影响\n· 上一版本已备份，本次启动确认健康后自动清理',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r2 === 0) {
      state.quitting = true;
      markCleanExit();
      killTree(state.serverProc);
      app.relaunch();
      app.exit(0);
    }
  } catch (err) {
    log('update', '更新失败: ' + err.message);
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成更新，仍使用当前版本。',
      detail: err.message,
      buttons: ['确定'],
    });
  } finally {
    state.updateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

// ---------------------------------------------------------------------------
// 内置插件更新检查（V4.3）：启动后静默执行。
//   · settings.pluginAutoUpdate = false（默认）→ 发现更新仅系统通知，不下载
//   · true → 自动下载到覆盖层（服务运行中不写 profile），弹窗提示重启
// 24h 节流（settings.pluginUpdateCheckedAt）+ 单插件失败不阻塞。
// ---------------------------------------------------------------------------

function notifyPluginUpdates(updatable) {
  try {
    const names = updatable.slice(0, 5).map((x) => x.name).join('、');
    const n = new Notification({
      title: '有 ' + updatable.length + ' 个内置插件可更新',
      body: names + (updatable.length > 5 ? ' 等' : '') + ' 已发布新版本。打开「设置 → 插件 → 更新」查看并更新（自动更新默认关闭，仅提示）。',
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.on('click', () => showMainWindow());
    n.show();
  } catch (err) {
    log('plugin-update', '更新通知发送失败: ' + (err && err.message));
  }
}

async function runPluginUpdateCheck(manual) {
  if (state.quitting) return;
  const ctx = updCtx();
  const sources = pluginUpdateSources(removedPluginIds());
  if (sources.length === 0) return;
  if (!manual && !pluginUpdater.dueForCheck(ctx, Date.now())) return;
  let list;
  try {
    list = await pluginUpdater.checkPluginUpdates(ctx, sources, { force: !!manual, profileDirP: desktopProfileDir() });
    if (!manual) pluginUpdater.markChecked(ctx);
  } catch (err) {
    log('plugin-update', '内置插件更新检查失败: ' + String((err && err.message) || err));
    return;
  }
  const updatable = list.filter((x) => x.hasUpdate && !x.skipped);
  if (updatable.length === 0) return;
  if (!pluginUpdater.isAutoUpdateEnabled(ctx)) {
    // 默认行为：只检测并提示，下载交给用户在「更新」标签页手动完成。
    notifyPluginUpdates(updatable);
    return;
  }
  const { done, failed } = await pluginUpdater.autoApplyUpdates(ctx, sources, {
    profileDirP: desktopProfileDir(),
    guard: ensureGuard(),
    copyIntoProfile: (overlayDir, name) => copyPluginPackage(desktopProfileDir(), overlayDir, name),
  });
  log('plugin-update', '自动更新完成: ' + (done.map((d) => d.name).join('、') || '无') + (failed.length ? '；失败 ' + failed.length + ' 个' : ''));
  if (done.length) {
    const names = done.map((d) => d.name).join('、');
    const { response } = await showBox({
      type: 'info',
      title: '内置插件已更新',
      message: '已更新内置插件：' + names,
      detail: '更新已写入用户目录，重启 Web 服务后生效（无需重启应用）。' + (failed.length ? '\n\n失败 ' + failed.length + ' 个：' + failed.map((f) => f.name).join('、') + '（可在「设置 → 插件 → 更新」重试）' : ''),
      buttons: ['立即重启服务', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      try { await restartWebServiceCore(); } catch (err) {
        log('plugin-update', '重启服务失败: ' + String((err && err.message) || err));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session-completion notifications
// ---------------------------------------------------------------------------

const lastNotifyAt = new Map(); // sessionId -> timestamp (rate-limit)

function onSessionTurnEnd(info) {
  if (!state.notifyOnTurnEnd || state.quitting) return;
  const now = Date.now();
  const last = lastNotifyAt.get(info.sessionId) || 0;
  if (now - last < 30000) return; // same session: at most one toast per 30s
  lastNotifyAt.set(info.sessionId, now);
  log('notify', '任务完成: ' + JSON.stringify(info));
  try {
    const n = new Notification({
      title: info.title || 'DSH 任务完成',
      body: info.body || '会话任务已完成',
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.on('click', () => {
      if (state.mainWindow) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.show();
        state.mainWindow.focus();
      }
    });
    n.show();
  } catch (err) {
    log('notify', '通知发送失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Chrome（自绘标题栏）IPC、托盘、余额、快捷方式
// ---------------------------------------------------------------------------



function registerChromeIpc() {
  ipcMain.handle('chrome:init', async (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return null;
    let iconDataUri = '';
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
      if (buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50) {
        iconDataUri = 'data:image/png;base64,' + buf.toString('base64');
      }
    } catch {}
    const s = updater.loadSettings(updCtx());
    const urls = repoUrls();
    return {
      appVersion: APP_VERSION,
      agentVersion: dshVersion(),
      agentSource: dshVersionSource(),
      notifyOnTurnEnd: state.notifyOnTurnEnd,
      closeToTray: s.closeToTray !== false,
      exitAction: getExitAction(),
      shortcutPolicy: s.shortcutPolicy === 'never' ? 'never' : 'auto',
      iconDataUri,
      repoUrls: urls,
      staticPort: state.previewStaticPort,
    };
  });

  // Renderer 心跳：preload 每 5s 上报一次，恢复状态机用它兜底判定
  // 「挂起但 Chromium 未发出 unresponsive」的场景。
  ipcMain.on('dsh:renderer-heartbeat', (event) => {
    if (state.recovery) state.recovery.noteHeartbeat(event.sender.id);
  });

  // 恢复页面（assets/recovery.html）的按钮与状态读取。全部校验来源必须是主窗。
  ipcMain.handle('chrome:recovery-state', (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return null;
    return {
      appVersion: APP_VERSION,
      logsDir: state.logsDir,
      crashDumpsDir: app.getPath('crashDumps'),
      state: state.recovery ? state.recovery.stateOf(state.mainWindow) : null,
    };
  });

  ipcMain.handle('chrome:recovery-reload', async (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    // 服务进程已退出时先重启服务（可能换新端口），再恢复加载。
    if (!state.serverProc || state.serverProc.exitCode !== null || state.serverProc.killed) {
      try {
        await startAndShowGuarded();
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    state.recovery.retryNow(state.mainWindow);
    return { ok: true };
  });

  ipcMain.handle('chrome:recovery-restart', (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    log('recovery', '用户在恢复页面选择重启客户端');
    state.quitting = true;
    state.forceQuit = true;
    markCleanExit();
    killTree(state.serverProc);
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // 一键导出诊断日志 zip（AC-8）：调用 structuredLogger.buildDiagnosticsZip，
  // 打包 logs + configs + updater meta + 最新备份 manifest，PII 二次脱敏后
  // 在文件管理器中选中 zip 文件，方便用户拖到反馈/GitHub issue 里。
  ipcMain.handle('chrome:export-logs', async (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const zipPath = await structuredLogger.buildDiagnosticsZip({ logsDir: state.logsDir, userDataDir: state.userDataDir, dshHome: state.dshHome });
      shell.showItemInFolder(zipPath);
      return { ok: true, zipPath };
    } catch (err) {
      log('boot', '导出诊断日志失败: ' + (err && err.message || err));
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('chrome:window', (event, { action } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return null;
    switch (action) {
      case 'minimize': state.mainWindow.minimize(); break;
      case 'toggle-maximize': state.mainWindow.isMaximized() ? state.mainWindow.unmaximize() : state.mainWindow.maximize(); break;
      case 'close': state.mainWindow.close(); break;
      case 'is-maximized': return state.mainWindow.isMaximized();
    }
    return null;
  });

  ipcMain.handle('chrome:menu', async (event, { action, value } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) {
      return { notifyOnTurnEnd: state.notifyOnTurnEnd, closeToTray: closeToTrayEnabled(), exitAction: getExitAction() };
    }
    switch (action) {
      case 'reload': state.mainWindow.reload(); break;
      case 'open-terminal': openBuiltinTerminal(); break;
      case 'devtools': state.mainWindow.webContents.toggleDevTools(); break;
      case 'fullscreen': state.mainWindow.setFullScreen(!state.mainWindow.isFullScreen()); break;
      case 'open-browser': if (state.webUrl) shell.openExternal(state.webUrl); break;
      case 'open-logs': shell.openPath(state.logsDir); break;
      case 'feedback': shell.openExternal('https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues'); break;
      case 'check-agent-update': runUpdateFlow(true); break;
      case 'check-client-update': runClientUpdateFlow(true); break;
      case 'toggle-notify': {
        state.notifyOnTurnEnd = !state.notifyOnTurnEnd;
        const s = updater.loadSettings(updCtx());
        s.notifyOnTurnEnd = state.notifyOnTurnEnd;
        updater.saveSettings(updCtx(), s);
        break;
      }
      case 'toggle-close-to-tray': setCloseToTray(!closeToTrayEnabled()); break;
      case 'set-exit-action': setExitAction(value); break;
      case 'restart-service': {
        // 不关闭应用重启 dsh web 服务（皮肤/插件切换后生效，等同市场安装
        // 后的自动重启路径）。窗口由 startAndShow 重载到新端口。
        const r = await restartWebServiceCore();
        if (!r.ok && r.error !== 'not-running') {
          showBox({
            type: 'error',
            title: '重启 Web 服务失败',
            message: 'dsh web 服务重启未成功。',
            detail: r.error,
            buttons: ['确定'],
          }).catch(() => {});
        }
        break;
      }
      case 'toggle-shortcut-policy': {
        // V4（用户建议③）：桌面快捷方式自动维护开关。关掉后启动不再自动
        // 创建/修复桌面快捷方式（开始菜单的仍维护 —— 系统通知的前置条件）。
        const s = updater.loadSettings(updCtx());
        s.shortcutPolicy = s.shortcutPolicy === 'never' ? 'auto' : 'never';
        updater.saveSettings(updCtx(), s);
        log('boot', '桌面快捷方式自动维护: ' + s.shortcutPolicy);
        break;
      }
      case 'about': showAbout(); break;
      case 'quit': state.forceQuit = true; app.quit(); break;
    }
    const menuState = updater.loadSettings(updCtx());
    return {
      notifyOnTurnEnd: state.notifyOnTurnEnd,
      closeToTray: closeToTrayEnabled(),
      exitAction: getExitAction(),
      shortcutPolicy: menuState.shortcutPolicy === 'never' ? 'never' : 'auto',
    };
  });

  // 插件市场：原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
  // 核心逻辑 restartWebServiceCore 在模块作用域（⋯ 菜单与托盘共用）。
  ipcMain.handle('chrome:restart-service', async (event, payload = {}) => {
    if (payload?.intent !== 'restart-service') return { ok: false, error: 'missing-intent' };
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    return restartWebServiceCore();
  });

  // 插件保护中心（plugin-guard.js）：快照 / 回滚 / 体检 / 修复 / 事故报告。
  // 设置页「插件保护」分区（dsh-plugin-shield 插件）从这里取数与触发动作。
  ipcMain.handle('guard:action', async (event, { action, value } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const g = ensureGuard();
    switch (action) {
      case 'status': {
        const st = (() => { try { return updater.loadSettings(updCtx()); } catch { return {}; } })();
        return {
          ok: true,
          profile: desktopProfile(),
          shareWebProfile: st.shareWebProfile === true,
          snapshots: g.listSnapshots().slice(0, 20),
          incidents: g.listIncidents().slice(0, 20),
          lastGood: g.lastGoodSnapshot(),
        };
      }
      case 'snapshot': {
        const s = g.snapshot(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        if (state.serverProc && !state.restartingServer) {
          // 服务运行中不能换配置文件（文件锁 + 进程内存态）：走标准重启窗口。
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        return g.restore(value);
      }
      case 'check':
        return { ok: true, report: g.healthCheck() };
      case 'repair': {
        const r = g.repair();
        return { ok: true, applied: r.applied };
      }
      case 'incident':
        return g.readIncident(value);
      case 'resolve-incident':
        return g.resolveIncident(value);
      default:
        return { ok: false, error: 'unknown action' };
    }
  });

  // 插件管理（V4，设置页「插件 → 管理」标签，dsh-plugin-manager 插件消费）：
  //   list —— 收集配套/用户/核心插件：id、包名、描述、启用状态
  //   set  —— 写入/移除 profile cordis.patch.yml 的用户层 disabled 条目
  //           （纯文本手术；完全退出并重启应用后生效）
  ipcMain.handle('dsh:plugin-list', async (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return [];
    return pluginManagerCollect();
  });

  ipcMain.handle('dsh:plugin-set-enabled', async (event, { id, enabled } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const row = pluginManagerCollect().find((r) => r.id === id);
    if (!row) return { ok: false, error: '未知插件: ' + String(id) };
    if (!row.toggleable) return { ok: false, error: '该插件不可关闭: ' + String(id) };
    try {
      const res = pluginManagerSetEnabled(id, !!enabled);
      if (!res.ok) return res;
      log('plugin-manager', '已' + (enabled ? '启用' : '关闭') + '插件 ' + id);
      return { ok: true, restartRequired: true };
    } catch (err) {
      log('plugin-manager', '设置插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 内置插件移除/恢复（V4.2）：移除 = 卸载语义（清 patch 行 + 删包副本 +
  // 记入 settings.removedPlugins 跳过下次 sync）；恢复 = 清跳过清单 + 立即
  // 复制包与行。两者都需重启 Web 服务生效。
  ipcMain.handle('dsh:plugin-set-removed', async (event, { id, removed } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const res = pluginManagerSetRemoved(String(id), !!removed);
      return res.ok ? { ok: true, restartRequired: true } : res;
    } catch (err) {
      log('plugin-manager', '移除/恢复插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 插件更新（V4.3，设置页「插件 → 更新」标签，dsh-plugin-marketplace 插件
  // 消费）：内置插件上游更新 —— 检测清单 / 手动更新单个 / 自动更新开关。
  // 数据与动作都在主进程完成（npm 镜像链 + 覆盖层），Web 端只做展示。
  ipcMain.handle('dsh:plugin-updates', async (event, { force = false } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return null;
    try {
      const ctx = updCtx();
      const list = await pluginUpdater.checkPluginUpdates(ctx, pluginUpdateSources(removedPluginIds()), {
        force: !!force,
        profileDirP: desktopProfileDir(),
      });
      return {
        list,
        autoUpdate: pluginUpdater.isAutoUpdateEnabled(ctx),
        checkedAt: updater.loadSettings(ctx).pluginUpdateCheckedAt || null,
      };
    } catch (err) {
      log('plugin-update', '插件更新清单加载失败: ' + String((err && err.message) || err));
      return { list: [], autoUpdate: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:plugin-update', async (event, { id } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const source = pluginUpdateSources(removedPluginIds()).find((s) => s.id === String(id));
    if (!source) return { ok: false, error: '未知或不可更新的内置插件: ' + String(id) };
    try {
      const res = await pluginUpdater.applyBuiltinPluginUpdate(updCtx(), source, {
        profileDirP: desktopProfileDir(),
        guard: ensureGuard(),
        copyIntoProfile: (overlayDir, name) => copyPluginPackage(desktopProfileDir(), overlayDir, name),
      });
      if (!res.ok) return res;
      if (res.noop) return { ok: true, noop: true, current: res.current, latest: res.latest };
      log('plugin-update', '手动更新内置插件 ' + id + ' → ' + res.latest + (res.restartRequired ? '（重启服务生效）' : ''));
      return { ok: true, version: res.latest, restartRequired: res.restartRequired };
    } catch (err) {
      log('plugin-update', '更新插件 ' + id + ' 失败: ' + String((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:plugin-auto-update', async (event, { enabled } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      s.pluginAutoUpdate = !!enabled;
      updater.saveSettings(ctx, s);
      log('plugin-update', '内置插件自动更新已' + (enabled ? '开启' : '关闭'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 图片粘贴（V4.2，dsh-image-paste 插件）：把剪贴板图片存到临时目录供
  // agent 的 inspect_image 读取。只接受 image/* 的 data URL，限 15MB，
  // 文件名清洗（防路径穿越），写入路径固定为 %TEMP%/dsh-paste/。
  ipcMain.handle('dsh:image-paste-save', async (event, { dataUrl, name } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const res = imagePasteSave(String(dataUrl || ''), String(name || '粘贴图片'));
      if (!res.ok) return res;
      log('plugin-manager', '已保存粘贴图片: ' + res.path);
      return res;
    } catch (err) {
      log('plugin-manager', '保存粘贴图片失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 内置插件选择向导（assets/onboarding.html，onboarding-preload.js 桥）：
  //   list   —— 目录（核心/推荐标记 + 描述 + 体积）+ 模式 + 当前启停状态
  //   submit —— 校验选择 → 写 disabled/裸条目 → 持久化 settings → 关窗；
  //             rerun 模式随后重启 Web 服务使 host 侧插件生效
  //   close  —— 用户点「跳过」/关闭窗口（走 closed 事件的 cancelled 分支）
  // 来源校验：只接受向导窗口自身的 webContents。
  ipcMain.handle('onboard:list', async (event) => {
    if (!state.wizardWindow || event.sender !== state.wizardWindow.webContents) return null;
    return {
      mode: state.wizardMode,
      catalog: buildOnboardingCatalog(),
      current: state.wizardMode === 'rerun' ? pluginCurrentState() : null,
    };
  });

  ipcMain.handle('onboard:submit', async (event, { ids } = {}) => {
    if (!state.wizardWindow || event.sender !== state.wizardWindow.webContents) return { ok: false, error: 'unauthorized' };
    // 首次向导时 sync 尚未运行、profile 目录可能还不存在：先按官方模板初始化
    // （package.json / pnpm-workspace.yaml / 空 patch 层），否则写盘 ENOENT。
    ensureDesktopProfileInit();
    const want = onboardingLogic.sanitizeSelection(ids, COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS);
    // 首次：patch 行尚未写全，normalize 全部非核心插件（current=null）；
    // 二次：只切换与用户选择不同的插件。
    const current = state.wizardMode === 'rerun' ? pluginCurrentState() : null;
    const ops = onboardingLogic.buildSelectionOps(COMPANION_PLUGINS, onboardingLogic.CORE_PLUGIN_IDS, want, current);
    const errors = [];
    for (const op of ops) {
      try {
        const res = pluginManagerSetEnabled(op.id, op.enable);
        if (!res.ok) errors.push(op.id + ': ' + (res.error || 'unknown'));
        else log('plugin-manager', '向导已' + (op.enable ? '启用' : '停用') + '内置插件 ' + op.id);
      } catch (err) {
        errors.push(op.id + ': ' + ((err && err.message) || err));
      }
    }
    const s = updater.loadSettings(updCtx());
    s.pluginOnboardingDone = true;
    s.builtinPluginSelection = Array.from(want);
    updater.saveSettings(updCtx(), s);
    log('boot', '插件选择向导已应用：' + ops.length + ' 个插件状态变更' + (errors.length ? '，失败 ' + errors.join('; ') : ''));
    const mode = state.wizardMode;
    closeWizard({ ok: true, applied: ops.length, errors });
    if (mode === 'rerun' && state.serverProc && state.serverProc.exitCode === null) {
      // 二次向导：重启 Web 服务让 host 侧插件生效（与插件市场安装后同路径）。
      restartWebServiceCore();
    }
    return { ok: true, applied: ops.length, errors };
  });

  ipcMain.on('onboard:close', (event) => {
    if (!state.wizardWindow || event.sender !== state.wizardWindow.webContents) return;
    closeWizard({ ok: false, cancelled: true });
  });

  // 设置页「插件 → 选择向导」（dsh-plugin-wizard 插件）二次打开入口。
  ipcMain.handle('onboard:open', (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (state.wizardWindow && !state.wizardWindow.isDestroyed()) {
      state.wizardWindow.focus();
      return { ok: true, reused: true };
    }
    openPluginWizard({ mode: 'rerun' });
    return { ok: true };
  });

  // 会话浮窗（V4 多窗口）：主窗请求把某个会话弹出到独立窗口（校验来源与
  // 数量上限）；浮窗自己只允许关闭自身。
  ipcMain.handle('chrome:float-window', (event, { action, sessionId } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (action !== 'open') return { ok: false, error: 'bad-action' };
    if (!state.webUrl) return { ok: false, error: 'not-ready' };
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'bad-session' };
    // 同一会话只保留一个浮窗：拖出/按钮连续触发或重复请求时，
    // 复用已有窗口而不是再开第二个。
    const existing = state.floatBySession.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, id: existing.id, reused: true };
    }
    if (existing) state.floatBySession.delete(sessionId);
    if (state.floatWindows.size >= FLOAT_MAX) return { ok: false, error: 'too-many' };
    const win = createFloatWindow(sessionId);
    if (!win) return { ok: false, error: 'too-many' };
    return { ok: true, id: win.id };
  });

  // 浮窗关闭：仅允许浮窗关闭自身（校验发送者属于某个浮窗）。
  ipcMain.on('float:close', (event) => {
    for (const win of state.floatWindows) {
      if (!win.isDestroyed() && win.webContents === event.sender) { win.close(); break; }
    }
  });

  // 复制文本到剪贴板（菜单「更新源」复制按钮 / 关于对话框）。
  ipcMain.handle('dsh:copy-text', (event, { text } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false };
    if (typeof text !== 'string' || !text || text.length > 2048) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  // preload 转发的页面异常（window.onerror / unhandledrejection）。
  ipcMain.on('dsh:page-error', (event, payload) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return;
    log('page-error', String(payload));
  });

  ipcMain.handle('dsh:balance-refresh', async (event) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return state.balanceCache;
    return refreshBalance();
  });

  // Token 价格自定义（V4.2，dsh-balance 插件「价格设置」页）：读写
  // settings.json 的 balancePrices.<model>.{peak,offpeak}（¥/百万 token，
  // 三字段 cacheMiss/cacheHit/output，必须为 >= 0 的数字）。保存后立即
  // 重推余额数据，dock 的费用估算即时生效。
  ipcMain.handle('dsh:balance-prices-get', async (event, { model } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const s = updater.loadSettings(updCtx());
    const defaults = balance.DEFAULT_PRICES[String(model || '')] || balance.FALLBACK_PRICES;
    const current = (s.balancePrices && s.balancePrices[String(model || '')]) || null;
    return { ok: true, model: String(model || ''), defaults, current };
  });

  ipcMain.handle('dsh:balance-prices-set', async (event, { model, prices } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const m = String(model || '');
    if (!balance.DEFAULT_PRICES[m]) return { ok: false, error: '未知模型: ' + m };
    try {
      const cleaned = balance.sanitizePrices(prices);
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      if (!s.balancePrices || typeof s.balancePrices !== 'object') s.balancePrices = {};
      s.balancePrices[m] = cleaned;
      updater.saveSettings(ctx, s);
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:balance-prices-reset', async (event, { model } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    const m = String(model || '');
    try {
      const ctx = updCtx();
      const s = updater.loadSettings(ctx);
      if (s.balancePrices && s.balancePrices[m]) {
        delete s.balancePrices[m];
        updater.saveSettings(ctx, s);
      }
      await refreshBalance();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 文件还原（「文件」视图的回退）：按会话日志里已持久化的写前/写后全文，
  // 做精确内容匹配后替换 —— 只有内容一致才动手，天然幂等且安全。
  ipcMain.handle('dsh:file-revert', async (event, { changes } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { results: [] };
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results = [];
    for (const c of changes) {
      const p = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(p) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: p, status: 'invalid' });
        continue;
      }
      if (!isUnderFileRoots(p)) {
        results.push({ path: p, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(p);
        const content = exists ? fs.readFileSync(p, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          // 新建 → 删除（内容必须仍是 agent 写入的原文）
          if (content !== null && content === newText) { fs.rmSync(p); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          // 删除 → 恢复（文件必须仍不存在）
          if (content === null) { fs.writeFileSync(p, oldText, 'utf8'); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: 'conflict' });
        } else {
          if (content !== null && content.includes(newText)) {
            fs.writeFileSync(p, content.replace(newText, oldText), 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: p, status: 'skipped' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: p, status: 'failed', error: String((err && err.message) || err) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  });

  // 「全部文件」视图的打开请求：用系统默认程序打开项目文件。
  ipcMain.handle('dsh:file-open', async (event, { path: p } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' };
    // Skills 根目录（~/.dsh/skills、~/.agents/skills）不在会话工作区内，但
    // 「设置 → Skills 与 MCP → 打开目录」需要放行；严格限定为两个根本身及其
    // 子路径（白名单，非任意路径），危险扩展名检查仍生效。
    const skillsRoots = [
      path.join(state.dshHome || path.join(os.homedir(), '.dsh'), 'skills'),
      path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
    ];
    const underSkillsRoot = skillsRoots.some((r) => {
      const rp = path.resolve(r);
      return p === rp || p.startsWith(rp + path.sep);
    });
    if (!underSkillsRoot && !isUnderFileRoots(p)) return { ok: false, error: 'path outside session workspace' };
    if (DANGEROUS_EXT.test(p)) return { ok: false, error: 'executable files are not openable from the file view' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'file not found' };
      const msg = await shell.openPath(p);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 预览面板：用系统浏览器打开 http(s) URL。
  ipcMain.handle('dsh:open-external', async (event, { url } = {}) => {
    if (!state.mainWindow || event.sender !== state.mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}


// ---------------------------------------------------------------------------
// DeepSeek 余额（推送到 Web UI 的 dsh-balance 插件）
// ---------------------------------------------------------------------------

async function refreshBalance() {
  const home = state.dshHome || path.join(os.homedir(), '.dsh');
  let result;
  try {
    result = await balance.queryBalance(home);
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err), balances: [] };
  }
  // 按当前默认模型选择价格档（settings.json 可覆盖 balancePrices.<model>，
  // 兼容旧扁平覆盖与新的 { peak, offpeak } 双档覆盖）。
  // 峰谷定价（2026-08-17 起）：按当前时段 pick 高峰/空闲档，两档随 pricing
  // 一起推给页面，时段切换后 client 可本地换档无需等下一次轮询。
  const model = balance.readActiveModel(home) || 'deepseek-v4-pro';
  const table = result.prices || balance.DEFAULT_PRICES;
  const s = updater.loadSettings(updCtx());
  const pricing = balance.computePricingState(s.pricing && s.pricing.peakWindows);
  const base = table[model] || balance.FALLBACK_PRICES;
  const ov = (s.balancePrices && s.balancePrices[model]) || {};
  const tier = (src) => balance.tierPrices(base, ov, src);
  result.prices = tier(pricing.period);
  result.pricing = { ...pricing, prices: { peak: tier('peak'), offpeak: tier('offpeak') } };
  state.balanceCache = result;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('dsh:balance', result);
  }
  return result;
}

function startBalanceLoop() {
  refreshBalance().catch(() => {});
  state.balanceTimer = setInterval(() => refreshBalance().catch(() => {}), 15 * 60 * 1000);
  if (state.balanceTimer.unref) state.balanceTimer.unref();
}




// ---------------------------------------------------------------------------
// 快捷方式维护：修复「没有桌面快捷方式 / 快捷方式指向的文件消失」，
// 并让快捷方式图标跟随图标设计更新（.lnk 单独指定 icon.ico）。
// ---------------------------------------------------------------------------

// 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。
const SHORTCUT_ICON_VERSION = 'whale-2';

function shortcutIconPath() {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(state.userDataDir, 'icon.ico');
  try {
    const src = path.join(__dirname, 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    log('boot', '复制快捷方式图标失败: ' + err.message);
    return path.join(__dirname, 'assets', 'icon.ico');
  }
}

// V4 修复「更换快捷方式图标后重启又多出一个快捷方式」：
//   旧逻辑只认「桌面\Deepseek Harness EAC.lnk」这个精确文件名。用户换
//   图标时通常删掉旧 .lnk 自建一个新的（名字几乎必然不同），下次启动
//   existsSync 判定缺失 → 再造一个标准名快捷方式 → 桌面上出现两个。
//   且图标版本分支会无条件 replace，把用户自定义图标静默还原成默认。
// 新逻辑：
//   1. 按「.lnk 的 target 是否指向本应用 exe」识别既有快捷方式（任意
//      文件名都算）—— 只要桌面上存在一个指向我们的 .lnk 就不再新建；
//   2. 图标刷新只在 .lnk 的 icon 仍指向我们自管的 icon.ico（即用户没有
//      自定义图标）时进行，用户自定义图标绝不覆盖；
//   3. settings.shortcutPolicy = 'never' 时完全不碰桌面快捷方式（⋯ 菜
//      单可切换），开始菜单快捷方式仍维护（系统通知的前置条件）。
function listLnkFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lnk'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function readLnkSafe(p) {
  try { return shell.readShortcutLink(p); } catch { return null; }
}

function lnkTargetsApp(lnkPath, target) {
  const link = readLnkSafe(lnkPath);
  if (!link || !link.target) return false;
  return path.resolve(String(link.target)).toLowerCase() === path.resolve(target).toLowerCase();
}

function lnkUsesManagedIcon(lnkPath, ico) {
  if (!ico) return false;
  const link = readLnkSafe(lnkPath);
  if (!link) return false;
  // 无自定义图标（icon 为空，用 target 自带）视为可接管。
  if (!link.icon) return true;
  return path.resolve(String(link.icon)).toLowerCase() === path.resolve(ico).toLowerCase();
}

function maintainShortcuts() {
  if (!app.isPackaged || !IS_WIN) return;
  // E2E / 自动化：跳过快捷方式维护（临时 exe 不得改写真实开始菜单/桌面
  // 快捷方式的指向）。与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同一约定。
  if (process.env.DSH_DESKTOP_TEST_NO_SHORTCUTS === '1') return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = updater.loadSettings(updCtx());
    const policy = settings.shortcutPolicy === 'never' ? 'never' : 'auto';
    const linksDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const APP_TITLE = 'Deepseek Harness EAC';
    const desktopDir = app.getPath('desktop');
    const startMenu = path.join(linksDir, APP_TITLE + '.lnk');
    const desktop = path.join(desktopDir, APP_TITLE + '.lnk');
    const ico = shortcutIconPath();
    const opts = {
      target,
      description: 'DeepSeek Harness 桌面客户端',
      ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      appUserModelId: 'com.deepseek.dsh.desktop',
    };
    let changed = false;
    // 清理旧名称（DSH Desktop）快捷方式：改名后它们指向的 exe 已不存在。
    for (const legacy of [
      path.join(linksDir, 'DSH Desktop.lnk'),
      path.join(desktopDir, 'DSH Desktop.lnk'),
    ]) {
      try { if (fs.existsSync(legacy)) { fs.rmSync(legacy); changed = true; } } catch {}
    }
    // exe 被移动过或图标设计更新：只刷新「确认属于本应用」的快捷方式。
    // 归属判定：target 指向当前 exe，或指向上次记录的 exe 位置（搬家后
    // 的旧快捷方式）；指向其它程序的 .lnk 绝不动。
    const targetMoved = settings.shortcutTarget && settings.shortcutTarget !== target;
    const iconOutdated = settings.shortcutIcon !== SHORTCUT_ICON_VERSION;
    if (targetMoved || iconOutdated) {
      const isOurs = (p) => fs.existsSync(p)
        && (lnkTargetsApp(p, target) || (targetMoved && lnkTargetsApp(p, settings.shortcutTarget)));
      const candidates = [startMenu].concat(policy === 'never' ? [] : listLnkFiles(desktopDir));
      for (const p of candidates) {
        if (!isOurs(p)) continue;
        // 仅图标过时且用户自定义了图标：尊重用户选择，跳过；target 移动
        // 时即使图标被自定义也要修指向（否则快捷方式失效）。
        if (!targetMoved && !lnkUsesManagedIcon(p, ico)) continue;
        try { shell.writeShortcutLink(p, 'replace', opts); changed = true; } catch {}
      }
    }
    // 开始菜单快捷方式：系统通知（Toast）的前置条件，按 target 匹配维护。
    const startMenuOk = fs.existsSync(startMenu) && lnkTargetsApp(startMenu, target);
    if (!startMenuOk) {
      try { shell.writeShortcutLink(startMenu, 'create', opts); changed = true; } catch {}
    }
    // 桌面快捷方式：policy=never 不创建；已有任意名称指向本应用的 .lnk
    // （用户自定义/改名/换图标后的产物）即视为存在，绝不重复新建。
    if (policy !== 'never' && !fs.existsSync(desktop)) {
      const hasOursOnDesktop = listLnkFiles(desktopDir).some((p) => lnkTargetsApp(p, target));
      if (!hasOursOnDesktop) {
        try { shell.writeShortcutLink(desktop, 'create', opts); changed = true; } catch {}
      } else {
        log('boot', '检测到用户自定义的桌面快捷方式（指向本应用），不再重复创建');
      }
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      updater.saveSettings(updCtx(), settings);
      log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    log('boot', '快捷方式维护失败: ' + err.message);
  }
}



// ---------------------------------------------------------------------------
// 客户端自更新流程（更新 DSH Desktop 封装本身）
// ---------------------------------------------------------------------------

async function runClientUpdateFlow(manual) {
  if (state.quitting) return;
  if (state.clientUpdateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '客户端更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  const settings = updater.loadSettings(ctx);
  let release;
  try {
    release = await clientUpdater.checkLatest(ctx, APP_VERSION);
  } catch (err) {
    log('client-update', '检查失败: ' + err.message);
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查客户端更新失败',
        message: '无法连接上游发布源。',
        detail: err.message + '\n\n可通过环境变量 DSH_DESKTOP_RELEASE_API 指定镜像 API。',
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!release.isNewer) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查客户端更新',
        message: '当前已是最新版本。',
        detail: `Deepseek Harness EAC（封装版本 v${APP_VERSION}）\n上游最新：${release.version}（${release.source}）`,
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!manual && settings.skipClientVersion === release.version) return;
  // M7 修复：用户选过"稍后"的同版本不再每 12h 重复弹窗/重复下载。
  if (!manual && settings.pendingClientVersion === release.version) return;
  // E2E 自动化钩子（与 DSH_DESKTOP_TEST_FORCE_UNSAFE 同惯例）：自动接受
  // 「立即更新」，让 scripts/e2e-v4.js 能无人值守跑完整更新链路。默认关闭。
  const autoAcceptUpdate = process.env.DSH_DESKTOP_TEST_AUTO_UPDATE === '1';
  const notes = release.body ? '\n\n更新说明：\n' + release.body.slice(0, 800) : '';
  const { response } = autoAcceptUpdate ? { response: 0 } : await showBox({
    type: 'info',
    title: '发现新版本客户端',
    message: `Deepseek Harness EAC 封装发布了新版本：v${release.version}`,
    detail: `当前版本：v${APP_VERSION}\n发布来源：${release.source}${notes}\n\n是否立即更新？下载后自动替换并重启应用。`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipClientVersion = release.version;
    updater.saveSettings(ctx, settings);
    log('client-update', '用户跳过版本 ' + release.version);
    return;
  }
  if (response === 2) {
    // M7 修复：记录"稍后"版本，周期检查不再重复打扰（新版本出现时仍会提示）。
    settings.pendingClientVersion = release.version;
    updater.saveSettings(ctx, settings);
    log('client-update', '用户稍后处理版本 ' + release.version);
    return;
  }

  state.clientUpdateBusy = true;
  const progressWin = showUpdateWindow(release.version, 'client');
  const progress = makeUpdateProgressPusher(progressWin);
  try {
    // V4.1 更新保障①：客户端更新前同样强制插件/配置快照，失败则中止
    //（下载与安装都不动 profile，但多一道回滚点总比少一道强）。
    if (!ensureGuard().snapshot('pre-update:client:' + release.version)) {
      throw new Error('更新前保护快照失败（profile 不可读），已中止客户端更新。');
    }
    // V4.2：探测其余发布源的同版本 release 作为备用下载源（GitHub ↔ Gitee），
    // 主源多次失败/卡住时自动切换，全程在弹窗内提示。
    const fallbacks = await clientUpdater.releaseFallbacks(ctx, release);
    const speedState = { t: 0, bytes: 0, speed: null };
    const { filePath, size } = await clientUpdater.downloadRelease(ctx, release, {
      fallbacks,
      onSourceChange: (source, idx, urls) => {
        log('client-update', `切换备用下载源（${idx + 1}/${urls.length}）`);
        progress.force({ stage: '下载停滞，已自动切换下载源（' + (idx + 1) + '/' + urls.length + '）…' });
      },
      onProgress: (received, total) => {
        const now = Date.now();
        if (speedState.t && now - speedState.t >= 500) {
          const inst = (received - speedState.bytes) / ((now - speedState.t) / 1000);
          speedState.speed = speedState.speed == null ? inst : speedState.speed * 0.7 + inst * 0.3;
        }
        speedState.t = now;
        speedState.bytes = received;
        const sp = speedState.speed || 0;
        const pct = total > 0 ? Math.round((received * 100) / total) : -1;
        const meta = {};
        if (pct >= 0 && sp > 0 && received < total) {
          meta.speedMBps = sp / 1048576;
          meta.etaSec = (total - received) / sp;
        }
        progress.client(received, total, meta);
      },
    });
    settings.pendingClientUpdate = { version: release.version, path: filePath, source: release.source };
    settings.skipClientVersion = null;
    settings.pendingClientVersion = null;
    updater.saveSettings(ctx, settings);
    const { response: r2 } = autoAcceptUpdate ? { response: 0 } : await showBox({
      type: 'info',
      title: '下载完成',
      message: `已准备好 Deepseek Harness EAC 封装 v${release.version}（${Math.round(size / 1048576)} MB）。`,
      detail: '立即重启应用完成更新？\n· 重启后自动安装新版本并启动\n· 插件、皮肤、会话与配置全部保留（仅替换程序本体）\n· 选择稍后重启：下次启动时再提示安装',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r2 === 0) {
      state.quitting = true;
      state.forceQuit = true;
      markCleanExit();
      updater.abort();
      if (state.sessionWatcher) state.sessionWatcher.stop();
      // V4：先等 dsh web 进程树真正退出（旧实现 killTree 的强杀补刀在
      // 主进程退出后不会执行，node.exe+conhost.exe 成对残留）。
      await killTreeAndWait(state.serverProc);
      state.serverProc = null;
      const clientUpdateOpts = {
        userDataDir: state.userDataDir,
        dshHome: state.dshHome,
        installDir: path.dirname(process.execPath),
        profileDir: path.join(state.dshHome, 'profiles', desktopProfile()),
        currentVersion: APP_VERSION,
        newVersion: release.version,
        nodeExe: nodeExe(),
      };
      clientUpdater.applyUpdate(ctx, settings.pendingClientUpdate, clientUpdateOpts);
      setTimeout(() => app.exit(0), 400);
    }
  } catch (err) {
    log('client-update', '更新失败: ' + err.message);
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成客户端更新，仍使用当前版本。',
      detail: err.message,
      buttons: ['确定'],
    });
  } finally {
    state.clientUpdateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

function offerPendingClientUpdate() {
  const ctx = updCtx();
  const settings = updater.loadSettings(ctx);
  const pending = settings.pendingClientUpdate;
  if (!pending || !pending.path) return;
  if (!fs.existsSync(pending.path)) {
    settings.pendingClientUpdate = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  if (updater.compareVersions(pending.version, APP_VERSION) <= 0) {
    settings.pendingClientUpdate = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  showBox({
    type: 'info',
    title: '有待安装的客户端更新',
    message: `已下载 Deepseek Harness EAC 封装 v${pending.version}，是否现在安装并重启？`,
    detail: '安装包保存在数据目录的 updates 文件夹中。\n插件、皮肤、会话与配置全部保留（仅替换程序本体）。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(async ({ response }) => {
    if (response !== 0) return;
    state.quitting = true;
    state.forceQuit = true;
    markCleanExit();
    updater.abort();
    if (state.sessionWatcher) state.sessionWatcher.stop();
    // V4：同 runClientUpdateFlow —— 等进程树退出再交给更新脚本接管。
    await killTreeAndWait(state.serverProc);
    state.serverProc = null;
    const clientUpdateOpts2 = {
      userDataDir: state.userDataDir,
      dshHome: state.dshHome,
      installDir: path.dirname(process.execPath),
      profileDir: path.join(state.dshHome, 'profiles', desktopProfile()),
      currentVersion: APP_VERSION,
      newVersion: pending.version,
      nodeExe: nodeExe(),
    };
    clientUpdater.applyUpdate(ctx, pending, clientUpdateOpts2);
    setTimeout(() => app.exit(0), 400);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------


// Issue #7: verify the bundled node_modules against the build-time manifest
// before starting dsh web. A botched upgrade leaves empty package skeletons;
// Node then dies with ERR_MODULE_NOT_FOUND in a loop. Tell the user to
// reinstall instead (with an escape hatch to continue anyway).
function verifyBundledModules() {
  if (!app.isPackaged) return Promise.resolve();
  const appDir = path.join(process.resourcesPath, 'app');
  const manifestPath = path.join(appDir, 'bundle-manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return Promise.resolve(); }
  const r = bundleIntegrity.verifyBundle(path.join(appDir, 'node_modules'), manifest);
  if (r.skipped || r.ok) return Promise.resolve();
  const sample = r.damaged.slice(0, 5).map((d) => `${d.name}（${d.reason}）`).join('、');
  log('boot', `捆绑依赖完整性校验失败（${r.damaged.length} 个包受损）: ${sample}${r.damaged.length > 5 ? ' 等' : ''}`);
  return showBox({
    type: 'error',
    title: '程序文件受损',
    message: `检测到 ${r.damaged.length} 个捆绑依赖包文件缺失，可能是升级中断或安全软件清理所致。`,
    detail: `受损包: ${sample}${r.damaged.length > 5 ? `（共 ${r.damaged.length} 个）` : ''}\n\n建议重新下载安装包覆盖安装（GitHub Releases 最新版）。\n选择「仍然启动」大概率无法正常运行。`,
    buttons: ['仍然启动', '退出'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response !== 0) {
      state.forceQuit = true;
      markCleanExit(); // 用户选择退出：不让看门狗拉起一个已知损坏的安装
      app.exit(1);
    }
  });
}

// 全新 vs 老用户判定（须在 run-state / migrate 标记 / 稳定端口等任何写盘
// 之前调用）：settings.json 在迁移流程里会被无条件创建，事后无法区分。
function computeOnboardingNeed() {
  const settings = updater.loadSettings(updCtx());
  return onboardingLogic.needsPluginOnboarding({
    settings,
    settingsFileExists: fs.existsSync(updater.settingsPath(updCtx())),
    profileDirExists: fs.existsSync(path.join(desktopProfileDir(), 'node_modules')),
    sharedProfileExists: fs.existsSync(path.join(state.dshHome || path.join(os.homedir(), '.dsh'), 'profiles', 'web')),
  });
}

async function boot() {
  // Portable builds keep all data next to the exe.
  if (!app.isPackaged && process.env.DSH_DESKTOP_USERDATA) {
    app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
  } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
  }

  state.userDataDir = app.getPath('userData');
  state.logsDir = path.join(state.userDataDir, 'logs');
  // DSH_HOME: respect an explicit override; otherwise let dsh use its own
  // default (~/.dsh), so the desktop app shares config/sessions with the CLI.
  state.dshHome = process.env.DSH_HOME || '';
  fs.mkdirSync(state.logsDir, { recursive: true });
  if (state.dshHome) fs.mkdirSync(state.dshHome, { recursive: true });
  // 日志系统（AC-1：先 init，后 log() 调用，保证结构化 boot 行落到 main.00）
  try {
    structuredLogger.init({
      logsDir: state.logsDir,
      level: process.env.DSH_LOG_LEVEL || (app.isPackaged ? 'info' : 'debug'),
      appVersion: APP_VERSION,
      env: app.isPackaged ? 'production' : 'development',
    });
  } catch (e) {
    // 日志系统初始化失败不影响启动（仍然写 desktop.log）。
    try { console.error('[logger.init fail]', e && e.message); } catch {}
  }
  state.desktopLog = fs.createWriteStream(path.join(state.logsDir, 'desktop.log'), { flags: 'a' });
  log('boot', `Deepseek Harness EAC（封装 ${APP_VERSION}）  userData=${state.userDataDir}  dshHome=${state.dshHome || '(dsh 默认)'}  agent=${dshVersion()}(${dshVersionSource()})`);

  // 移除原生菜单栏（文件/视图/帮助），全部功能由自绘 chrome 与托盘提供。
  Menu.setApplicationMenu(null);
  startPreviewStaticServer();
  registerChromeIpc();
  createTray();
  // 新老用户判定必须在任何写盘之前：run-state / migrate 标记 / 稳定端口
  // 都会在启动早期创建 settings.json，事后无法区分全新安装与升级。
  const onboardingNeeded = computeOnboardingNeed();
  // 看门狗 + 运行状态标记（安装版）：意外崩溃后自动拉起并告知用户。
  writeRunState();
  startWatchdog();
  const uncleanPrev = detectUncleanPreviousRun();
  // V4.1 更新保障③：便携版客户端更新后若新版崩溃（非干净退出 + 上一版
  // 备份 marker 仍在），先用上一版还原再继续启动，随后再告知用户。
  autoRollbackClientIfCrashed(uncleanPrev);
  if (uncleanPrev) notifyUncleanRestart(uncleanPrev);
  // 渲染进程崩溃/挂起自恢复状态机：必须在 createWindow 之前装配。
  initRendererRecovery();
  startHeartbeatLoop();
  // 一次性迁移：从共享 web profile 切到桌面专属 profile（与原生 CLI 共存）。
  migrateFromSharedWebProfile();
  // 首次启动内置插件选择向导：仅全新用户展示（升级用户静默跳过）。提交的
  // 选择在 onboard:submit 里已写入 patch（disabled/裸条目），此后 sync 的
  // 「已有行不重写」规则天然保留用户选择。
  await runPluginOnboardingIfNeeded(onboardingNeeded);
  syncCompanionPlugins();
  syncBundledSkills();
  healProfileModules();
  createWindow();
  // koffi FFI 预检（koffi-preflight.js，V4 改异步：同步 spawnSync 会把主
  // 进程事件循环卡住最长 20 秒）：失败则注入目录选择器降级 overlay，
  // 由 startAndShow 以 --patch 交给 dsh web。必须在 startAndShow 之前完成。
  // junction 归属守卫：原生 dsh 会把共享模块指到它自己的闭包，这里先纠偏
  // 一次，并启动周期巡检（原生进程退出后自动恢复指向）。
  applyKoffiPreflightAsync()
    .then(() => {
      ensureGuard().repairJunctions();
      startJunctionWatchdog();
    })
    // 插件市场排队任务（服务运行中撞文件锁转待重启的安装/卸载）：趁服务
    // 尚未启动、无文件锁时先完成，再拉起 Web 服务。
    .then(() => processPendingMarketOps())
    .then(async () => {
      // 排队的 pnpm 操作可能刚重写 profile node_modules（删掉配套插件副本、
      // hoist 核心包形成双实例）—— 服务启动前重建副本并清理遮蔽，
      // 保证加载的始终是内置分发版本。
      syncCompanionPlugins();
      syncBundledSkills();
      healProfileModules();
      // V4 兜底：上次 pnpm 后异常退出没回填的第三方构建产物（meow-memory
      // 的 lib/ 等）在这里补上（processPendingMarketOps 正常路径已含回填，
      // 这里覆盖崩溃/强杀场景；无缓存时为空操作）。
      await restoreKeptArtifacts(desktopProfile());
    })
    .then(() => verifyBundledModules())
    .then(() => startAndShowGuarded())
    .then(() => {
      // V4.1 更新保障②/③：新版健康启动 —— 清理官方 dsh 上一版本备份与
      // 便携版客户端旧 exe 备份（崩溃自回退的保险丝就此解除）。
      updater.confirmPreviousAgentHealthy(updCtx());
      cleanupClientBackupIfHealthy();
      // V4.3 PR（独有价值）：客户端更新成功后 24h 内非阻塞询问是否清理 4 目录备份
      // （超 24h 自动登记 pendingBackupCleanup；确认删时保留 manifest.json 诊断副本）；
      // 无空 setTimeout 死代码。
      offerBackupCleanupConfirm();
      // Session-completion notifications: watch dsh session logs under the
      // effective DSH_HOME (same config the CLI uses).
      const s = updater.loadSettings(updCtx());
      state.notifyOnTurnEnd = s.notifyOnTurnEnd !== false;
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      state.sessionWatcher = new SessionWatcher({
        sessionsDir: path.join(home, 'sessions'),
        log,
        onTurnEnd: (info) => onSessionTurnEnd(info),
      });
      state.sessionWatcher.start();
      maintainShortcuts();
      warnTempRun();
      startBalanceLoop();
      offerPendingClientUpdate();

      if (!process.env.DSH_DESKTOP_SKIP_AUTO_UPDATE) {
        // dsh agent 更新：启动 15 秒后 + 每 6 小时。
        setTimeout(() => runUpdateFlow(false), 15000).unref();
        setInterval(() => runUpdateFlow(false), AUTO_UPDATE_INTERVAL_MS).unref();
      }
      if (!process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE) {
        // 客户端（封装）更新：启动 60 秒后 + 每 12 小时。
        setTimeout(() => runClientUpdateFlow(false), 60000).unref();
        setInterval(() => runClientUpdateFlow(false), 12 * 3600 * 1000).unref();
      }
      if (!process.env.DSH_DESKTOP_SKIP_PLUGIN_UPDATE) {
        // 内置插件上游更新检查：启动 20 秒后 + 每 6 小时（24h 落盘节流
        // 在 runPluginUpdateCheck 内；默认仅提示，见 plugin-updater.js）。
        setTimeout(() => runPluginUpdateCheck(false), 20000).unref();
        setInterval(() => runPluginUpdateCheck(false), 6 * 3600 * 1000).unref();
      }
    })
    .catch((err) => handleBootFailure(err));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.deepseek.dsh.desktop');
  app.on('second-instance', () => {
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      state.mainWindow.show();
      state.mainWindow.focus();
    }
  });
  app.on('before-quit', (event) => {
    // V4：退出必须等 dsh web 进程树真正死透再退（见 killTreeAndWait 注释）。
    // 首次事件里阻止默认退出，完成异步清理后 app.exit(0)；后续重复事件
    // （window-all-closed 触发的 app.quit 等）直接放行。
    if (state.shutdownInProgress) return;
    state.shutdownInProgress = true;
    event.preventDefault();
    state.quitting = true;
    state.forceQuit = true;
    const t0 = Date.now();
    log('boot', '正在退出，停止 dsh web 进程树…');
    markCleanExit();
    (async () => {
      try {
        closeAllFloatWindows();
        // 正在跑的插件市场排队任务：直接强杀（它只是 pnpm 的转发器，
        // 标记文件的 attempts 机制会在下次启动重试）。
        if (state.marketOpChild && state.marketOpChild.pid && state.marketOpChild.exitCode === null) {
          try {
            spawn('taskkill', ['/pid', String(state.marketOpChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch {}
        }
        await killTreeAndWait(state.serverProc);
        updater.abort();
        if (state.sessionWatcher) state.sessionWatcher.stop();
      } catch (err) {
        log('boot', '退出清理异常: ' + err.message);
      } finally {
        if (state.balanceTimer) clearInterval(state.balanceTimer);
        if (state.tray) { try { state.tray.destroy(); } catch {} state.tray = null; }
        log('boot', `退出清理完成（耗时 ${Date.now() - t0}ms）`);
        // 日志系统 flush：结构化 logger 先关（flush 缓冲区+结束 rotation stream），
        // 再关 desktop.log 纯文本，保证退出前两条通道都落盘。
        try { structuredLogger.close(); } catch {}
        try { if (state.desktopLog) state.desktopLog.end(); } catch {}
        app.exit(0);
      }
    })();
  });
  // 关闭窗口后常驻托盘；托盘不存在时才随窗口退出。
  app.on('window-all-closed', () => {
    if (!IS_WIN || !state.tray) app.quit();
  });
  app.whenReady().then(boot).catch((err) => fatal('应用初始化失败', err));
}
