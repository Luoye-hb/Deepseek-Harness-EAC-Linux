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
// Task 5b 提取的模块：保护中心装配 / koffi 预检 / 选择向导 / 余额通知 /
// 快捷方式维护 / 双更新流。
const { ensureGuard } = require('./lib/guard.js');
const { applyKoffiPreflightAsync } = require('./lib/preflight.js');
const {
  closeWizard, buildOnboardingCatalog, pluginCurrentState, openPluginWizard,
  runPluginOnboardingIfNeeded, computeOnboardingNeed,
} = require('./lib/onboarding.js');
const { refreshBalance, startBalanceLoop, onSessionTurnEnd } = require('./lib/balance-ui.js');
const { maintainShortcuts } = require('./lib/shortcuts.js');
const {
  runUpdateFlow, runPluginUpdateCheck, runClientUpdateFlow,
  offerPendingClientUpdate, scheduleClientUpdateRescue,
} = require('./lib/update-flow.js');
// bridge 更新：guard 与更新流已迁入 lib。
bridge.ensureGuard = ensureGuard;
bridge.runUpdateFlow = runUpdateFlow;
bridge.runClientUpdateFlow = runClientUpdateFlow;
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
