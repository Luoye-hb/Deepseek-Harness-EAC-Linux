'use strict';

// Deepseek Harness EAC 客户端自更新引擎（更新“封装客户端本身”，与 updater.js 的
// dsh agent 更新互相独立）。
//
// 流程：
//   1. checkLatest(): 依次查询上游发布源（GitHub Releases → Gitee Releases，
//      可用环境变量 DSH_DESKTOP_RELEASE_API 指向自定义镜像 API），取 latest
//      release 的 tag 作为版本号，与当前 APP_VERSION 比较。
//   2. selectAsset(): 按当前部署形态选择安装包 —— 便携版选
//      *-portable-x64.exe；安装版选 Setup-*-x64.exe。Gitee 因单文件 100MB
//      限制把安装包拆成 .part1/.part2 分片，此时自动按序下载并拼接。
//   3. downloadRelease(): 流式下载（带进度回调）到 <userData>/updates/。
//   4. applyUpdate(): 写一个纯 ASCII 的 cmd 脚本并以 detached 方式启动，随后
//      主进程退出：
//      · 便携版：等旧 exe 解锁 → 备份 → 用新 exe 原地替换 → 重新启动；
//        若旧 exe 所在目录只读，则退化为直接启动新 exe（保留旧文件）。
//      · 安装版：等 Deepseek Harness EAC 进程退出 → 以向导方式启动新 Setup 安装包
//        （安装器会记录原安装目录并在完成后自动启动新版本）。

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { compareVersions } = require('./updater');

// Electron 主进程下优先用 net 模块（Chromium 网络栈）发请求：走系统代理
// 与系统 CA 信任库。用户网络里 Node https 常见的两类硬伤它都能正确处理：
//   ① 企业/网关 MITM 证书不在 Node 内置 Mozilla CA 列表 —— 报
//      "unable to verify the first certificate"，检查更新直接失败；
//   ② 系统代理（如 127.0.0.1:7890）Node https 根本不读，直连 GitHub
//      超时。纯 Node 环境（单测）下 electron 不可用，自动回落 node https。
let electronNet = null;
try {
  const electron = require('electron');
  if (electron && typeof electron.net === 'object' && typeof electron.net.request === 'function') {
    electronNet = electron.net;
  }
} catch { /* plain node (tests): fall back to node https */ }

/** 统一取响应头字段（net 与 http 的 header 值类型不一致，可能是数组）。 */
function headerValue(headers, name) {
  const v = headers && headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const DEFAULT_REPOS = { github: 'zouyuxuan122/Deepseek-Harness-EAC', gitee: 'zouyuxuan122/Deepseek-Harness-EAC' };
const REPO_SLUG = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;
const MIN_VALID_BYTES = 64 * 1024 * 1024; // 完整安装包远大于 64MB，防止把错误页当 exe

function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

/** 解析仓库地址（格式非法或缺省时回退到内置默认仓库）。 */
function resolveRepos(repos) {
  const r = repos && typeof repos === 'object' ? repos : {};
  const github = REPO_SLUG.test(String(r.github || '')) ? r.github : DEFAULT_REPOS.github;
  const gitee = REPO_SLUG.test(String(r.gitee || '')) ? r.gitee : DEFAULT_REPOS.gitee;
  return { github, gitee };
}

function apiEndpoints() {
  if (process.env.DSH_DESKTOP_RELEASE_API) {
    return [{ name: '自定义镜像', url: process.env.DSH_DESKTOP_RELEASE_API }];
  }
  const { github, gitee } = resolveRepos();
  return [
    {
      name: 'GitHub',
      url: `https://api.github.com/repos/${github}/releases/latest`,
      headers: { Accept: 'application/vnd.github+json' },
    },
    { name: 'Gitee', url: `https://gitee.com/api/v5/repos/${gitee}/releases/latest` },
  ];
}

// --- HTTP ----------------------------------------------------------------

/**
 * 统一的"取响应"原语：resolve { status, headers, stream }。
 * electron.net 路径自动跟随重定向（含跨域）、自动走系统代理与系统 CA；
 * node https 回退路径手动跟随重定向（≤5 次）。timeoutMs 只约束到响应头
 * 到达（TTFB），响应体由调用方各自控制。
 */
function getResponse(url, { headers = {}, timeoutMs = 20000, redirects = 0 } = {}) {
  if (redirects > 5) return Promise.reject(new Error('重定向次数过多'));
  if (electronNet) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = electronNet.request({ url, redirect: 'follow' });
      } catch (err) {
        return reject(err);
      }
      for (const [k, v] of Object.entries({ 'User-Agent': 'DSH-Desktop', ...headers })) {
        try { req.setHeader(k, v); } catch { /* 无效头名等，忽略 */ }
      }
      const timer = setTimeout(() => {
        try { req.destroy(new Error('请求超时')); } catch { /* already destroyed */ }
      }, timeoutMs);
      req.on('response', (res) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, stream: res });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      req.end();
    });
  }
  return new Promise((resolve, reject) => {
    // 自定义镜像（DSH_DESKTOP_RELEASE_API）与单测允许 http:// 端点
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'DSH-Desktop', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getResponse(new URL(res.headers.location, url).toString(), { headers, timeoutMs, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function httpGetJson(url, headers = {}, timeoutMs = 20000) {
  const { status, stream } = await getResponse(url, { headers, timeoutMs });
  if (status !== 200) {
    stream.resume();
    throw new Error('HTTP ' + status);
  }
  let body = '';
  await new Promise((resolve, reject) => {
    stream.setEncoding('utf8');
    stream.on('data', (c) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) stream.destroy(new Error('响应过大'));
    });
    stream.on('end', resolve);
    stream.on('aborted', () => reject(new Error('连接中断')));
    stream.on('error', reject);
  });
  try { return JSON.parse(body); } catch { throw new Error('JSON 解析失败'); }
}

// --- release 规范化 -------------------------------------------------------

function normalizeRelease(source, data) {
  const tag = String(data.tag_name || data.tag || data.name || '').trim();
  const version = tag.replace(/^v/i, '');
  const assets = Array.isArray(data.assets)
    ? data.assets
        .map((a) => ({
          name: String(a.name || ''),
          url: String(a.browser_download_url || a.url || ''),
          size: Number(a.size || 0),
        }))
        .filter((a) => a.name && a.url)
    : [];
  return {
    source,
    version,
    name: data.name || null,
    body: String(data.body || ''),
    htmlUrl: data.html_url || null,
    assets,
  };
}

async function checkLatest(ctx, currentVersion) {
  const errors = [];
  for (const ep of apiEndpoints()) {
    try {
      const data = await httpGetJson(ep.url, ep.headers || {});
      const rel = normalizeRelease(ep.name, data);
      if (!rel.version || !rel.assets.length) {
        throw new Error('上游 release 缺少版本号或安装包资产');
      }
      rel.isNewer = compareVersions(rel.version, currentVersion) > 0;
      ctx.log('client-update', `[${ep.name}] latest=${rel.version} 当前=${currentVersion} 资产数=${rel.assets.length}`);
      return rel;
    } catch (err) {
      errors.push(`${ep.name}: ${err.message}`);
      ctx.log('client-update', `[${ep.name}] 查询失败: ${err.message}`);
    }
  }
  throw new Error('无法连接上游发布源（' + errors.join('；') + '）');
}

// --- 资产选择 / 下载 -------------------------------------------------------

function selectAsset(release) {
  // 资产命名：Deepseek-Harness-EAC-<version>-Setup-x64.exe / …-Portable-x64.exe。
  // 旧正则 /-setup-.*-x64\.exe$/ 要求 -setup- 之后还有第二个 "-x64"，
  // 对 "…-v2.0.1-Setup-x64.exe"（-Setup- 直接连 x64.exe）永远匹配失败，
  // 更新流程卡死在"未找到匹配的安装包资产"。锚定 \.exe$ 保证 .blockmap
  // 等附属资产不会被误选。
  const wanted = isPortable() ? /portable.*x64\.exe$/i : /setup.*x64\.exe$/i;
  const direct = release.assets.find((a) => wanted.test(a.name));
  if (direct) return { parts: [direct], name: direct.name, totalSize: direct.size };

  // Gitee 单文件 100MB 限制：安装包拆分为 <file>.part1 / <file>.part2 …
  // v2.0.3 起 artifact 名不再带版本号，两个候选都试（覆盖旧 Release）。
  const kind = isPortable() ? 'Portable' : 'Setup';
  const bases = [
    `Deepseek-Harness-EAC-${kind}-x64.exe`,
    `Deepseek-Harness-EAC-v${release.version}-${kind}-x64.exe`,
    `Deepseek-Harness-EAC-${release.version}-${kind}-x64.exe`,
  ];
  let base = '';
  let parts = [];
  for (const b of bases) {
    parts = release.assets
      .filter((a) => a.name.startsWith(b + '.part'))
      .sort((a, b2) => {
        const n = (s) => parseInt(s.split('part').pop(), 10) || 0;
        return n(a.name) - n(b2.name);
      });
    if (parts.length) { base = b; break; }
  }
  if (!parts.length) {
    throw new Error('未找到匹配的安装包资产（' + release.assets.map((a) => a.name).join(', ') + '）');
  }
  return { parts, name: base, totalSize: parts.reduce((s, p) => s + p.size, 0) };
}

/** 单次下载尝试。resumeFrom > 0 时发 Range 续传请求并以追加模式写入；
 *  失败时保留 .part 供下一次断点续传（不删）。 */
function downloadFileOnce(url, dest, { onProgress, resumeFrom = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    let received = resumeFrom;
    let settled = false;
    let idleTimer = null;
    const finish = (fn, value) => { if (!settled) { settled = true; if (idleTimer) clearTimeout(idleTimer); fn(value); } };
    // 空闲超时：60 秒没有任何数据到达才判死（167MB 的安装包在慢链路上
    // 要传十几分钟，不能设整体超时）。每个数据块重置计时。
    const bumpIdle = (stream) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { stream.destroy(new Error('下载超时')); } catch { /* already destroyed */ }
      }, 60000);
    };
    const reqHeaders = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
    getResponse(url, { timeoutMs: 60000, headers: reqHeaders }).then(({ status, headers, stream }) => {
      if (settled) { stream.resume(); return; }
      if (status === 416) {
        // .part 比远端文件还长（上轮损坏/上游换了文件）：作废重来
        stream.resume();
        try { fs.rmSync(tmp, { force: true }); } catch {}
        return finish(reject, new Error('RESUME_INVALID'));
      }
      const partial = status === 206;
      if (status !== 200 && !partial) {
        stream.resume();
        return finish(reject, new Error('下载失败 HTTP ' + status));
      }
      if (partial) {
        const cr = String(headerValue(headers, 'content-range') || '');
        const m = /^bytes (\d+)-/i.exec(cr);
        if (m && Number(m[1]) !== resumeFrom) {
          stream.resume();
          return finish(reject, new Error('RESUME_INVALID'));
        }
      }
      // 服务器忽略 Range 回 200 全量时必须覆盖写（追加会把旧半截拼在前面）
      const append = partial && resumeFrom > 0;
      if (!append) received = 0;
      const file = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' });
      const fail = (err) => {
        file.close(() => {});
        // 保留 .part：下一次重试从已落盘字节续传
        finish(reject, err);
      };
      const declared = Number(headerValue(headers, 'content-length') || 0);
      const total = append ? (declared ? resumeFrom + declared : 0) : declared;
      bumpIdle(stream);
      stream.on('data', (c) => {
        received += c.length;
        bumpIdle(stream);
        if (onProgress) { try { onProgress(received, total); } catch {} }
      });
      stream.on('aborted', () => fail(new Error('连接中断')));
      stream.on('error', fail);
      file.on('finish', () => {
        if (settled) return;
        try { fs.renameSync(tmp, dest); } catch (err) { return finish(reject, err); }
        finish(resolve, { path: dest, size: received });
      });
      file.on('error', fail);
      stream.pipe(file);
    }, finish.bind(null, reject));
  });
}

/** 带断点续传 + 指数退避重试的下载。慢链路上 167MB 直连常被 RST
 *  （net::ERR_CONNECTION_RESET），一锤子流下载必然偶发失败；每次重试
 *  从已落盘的 .part 断点继续，而不是整包重来。 */
async function downloadFile(url, dest, { onProgress, ctx = null, maxAttempts = 10 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resumeFrom = 0;
    try { resumeFrom = fs.statSync(dest + '.part').size; } catch { /* 无残留，全新下载 */ }
    if (attempt > 1 || resumeFrom > 0) {
      ctx?.log?.('client-update', `下载尝试 ${attempt}/${maxAttempts}（从 ${Math.round(resumeFrom / 1048576)} MB 处续传）`);
    }
    try {
      return await downloadFileOnce(url, dest, { onProgress, resumeFrom });
    } catch (err) {
      lastErr = err;
      if (err.message === 'RESUME_INVALID') continue; // .part 已作废，立即全新重试
      if (attempt < maxAttempts) {
        const delay = Math.min(3000 * 2 ** (attempt - 1), 30000);
        ctx?.log?.('client-update', `下载中断（${err.message}），${Math.round(delay / 1000)}s 后从断点重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error('下载失败');
}

async function concatFiles(sources, dest) {
  const out = fs.createWriteStream(dest);
  for (const s of sources) {
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(s);
      rs.on('error', rej);
      rs.on('end', res);
      rs.pipe(out, { end: false });
    });
    fs.rmSync(s, { force: true });
  }
  await new Promise((res, rej) => {
    out.on('error', rej);
    out.end(res);
  });
}

async function downloadRelease(ctx, release, { onProgress } = {}) {
  const dir = path.join(ctx.userDataDir, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const sel = selectAsset(release);
  const split = sel.parts.length > 1;
  const finalPath = path.join(dir, sel.name);
  const partPaths = [];
  let merged = 0;
  for (let i = 0; i < sel.parts.length; i++) {
    const p = sel.parts[i];
    ctx.log('client-update', `下载 ${p.name}（${Math.round(p.size / 1048576)} MB）`);
    const dest = split ? finalPath + '.part' + (i + 1) : finalPath;
    const res = await downloadFile(p.url, dest, {
      ctx,
      onProgress: (r) => {
        if (onProgress) onProgress(split ? merged + r : r, sel.totalSize);
      },
    });
    if (split) { merged += res.size; partPaths.push(dest); }
  }
  if (split) {
    ctx.log('client-update', `合并 ${partPaths.length} 个分片 → ${sel.name}`);
    await concatFiles(partPaths, finalPath);
  }
  const stat = fs.statSync(finalPath);
  if (stat.size < MIN_VALID_BYTES) {
    fs.rmSync(finalPath, { force: true });
    throw new Error('下载文件异常（仅 ' + Math.round(stat.size / 1048576) + ' MB），已丢弃');
  }
  if (sel.totalSize > 0 && Math.abs(stat.size - sel.totalSize) > 2 * 1024 * 1024) {
    ctx.log('client-update', `大小与上游声明不一致：期望 ${sel.totalSize} 实际 ${stat.size}（继续，安装器会自校验）`);
  }
  ctx.log('client-update', `下载完成: ${finalPath}（${Math.round(stat.size / 1048576)} MB）`);
  return { filePath: finalPath, size: stat.size };
}

// --- 应用更新（detached 脚本 + 主进程退出） ---------------------------------

/**
 * 生成 apply-update.cmd 的行内容（纯 ASCII，join('\r\n') 后落盘）。
 *
 * issue #8 回归约束（对应 test/client-updater-apply.test.mjs）：
 *   1. 安装版分支：等待旧进程退出必须有界（约 30s），超时 taskkill /F /T
 *      强杀——托盘应用关窗后进程仍存活，无界等待会让 Setup 永远不执行。
 *   2. 全程写 apply-update.log（与脚本同目录），记录等待/强杀/运行/退出码。
 *   3. Setup 失败：保留安装包与日志供诊断，并拉起旧版应用，用户不被困住。
 *   4. 清理（删安装包+自删）仅在成功路径发生。
 *   5. 便携版分支保留 备份→替换→失败回滚 语义，同样有界等待并写日志。
 */
function buildApplyScript({ newExe, oldExe, portable }) {
  const lines = ['@echo off'];
  if (portable) {
    lines.push(
      'set "NEW=%~1"',
      'set "OLD=%~2"',
      'set "LOG=%~dp0apply-update.log"',
      'echo [%date% %time%] portable apply-update start > "%LOG%"',
      'set /a tries=0',
      ':wait',
      'set /a tries+=1',
      'if %tries% gtr 300 goto failed',
      'ping -n 2 127.0.0.1 >nul',
      'if not exist "%OLD%" goto replace',
      'copy /y "%OLD%" "%OLD%.bak" >nul 2>&1',
      'if errorlevel 1 goto wait',
      'del /f /q "%OLD%" >nul 2>&1',
      'if exist "%OLD%" goto wait',
      ':replace',
      'echo [%date% %time%] replacing portable exe >> "%LOG%"',
      'copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if errorlevel 1 goto failed',
      'del "%NEW%" >nul 2>&1',
      'start "" "%OLD%"',
      'if exist "%OLD%.bak" del "%OLD%.bak" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0',
      ':failed',
      'echo [%date% %time%] portable update failed, restoring >> "%LOG%"',
      // M3 修复：超时后先尽力复制回原位再启动，避免便携版从 updates 目录
      // 直接启动导致新建 data 目录、丢失设置。
      'if exist "%OLD%.bak" copy /y "%OLD%.bak" "%OLD%" >nul 2>&1',
      'if not exist "%OLD%" copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if exist "%OLD%" (start "" "%OLD%") else (start "" "%NEW%")',
      'if exist "%OLD%.bak" del "%OLD%.bak" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0'
    );
  } else {
    lines.push(
      'set "SETUP=%~1"',
      'set "EXENAME=%~2"',
      'set "OLD=%~3"',
      'set "LOG=%~dp0apply-update.log"',
      'echo [%date% %time%] apply-update start > "%LOG%"',
      'set /a tries=0',
      ':wait',
      'set /a tries+=1',
      'if %tries% gtr 15 goto kill',
      'ping -n 2 127.0.0.1 >nul',
      'tasklist /fi "IMAGENAME eq %EXENAME%" 2>nul | find /i "%EXENAME%" >nul',
      'if not errorlevel 1 goto wait',
      'echo [%date% %time%] app exited after %tries% checks >> "%LOG%"',
      'goto run',
      ':kill',
      'echo [%date% %time%] app still alive, force killing >> "%LOG%"',
      'taskkill /F /T /IM "%EXENAME%" >> "%LOG%" 2>&1',
      'ping -n 3 127.0.0.1 >nul',
      ':run',
      'echo [%date% %time%] running setup >> "%LOG%"',
      'start /wait "" "%SETUP%"',
      'echo [%date% %time%] setup exit code %errorlevel% >> "%LOG%"',
      'if errorlevel 1 goto failed',
      'goto success',
      ':success',
      'echo [%date% %time%] update applied >> "%LOG%"',
      'del "%SETUP%" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0',
      ':failed',
      'echo [%date% %time%] update failed, installer kept for diagnosis >> "%LOG%"',
      'if not "%OLD%" == "" if exist "%OLD%" start "" "%OLD%"',
      'exit /b 1'
    );
  }
  return lines;
}

function applyUpdate(ctx, pending) {
  const newExe = pending.path;
  const portable = isPortable();
  const oldExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const exeBase = path.basename(oldExe);
  const script = path.join(ctx.userDataDir, 'updates', 'apply-update.cmd');
  const lines = buildApplyScript({ newExe, oldExe, portable });
  fs.writeFileSync(script, lines.join('\r\n'));
  ctx.log('client-update', `启动更新脚本: ${script}（新: ${newExe}，旧: ${oldExe}）`);
  const child = spawn('cmd.exe', ['/c', script, newExe, portable ? oldExe : exeBase, portable ? '' : oldExe], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return script;
}

module.exports = { checkLatest, selectAsset, downloadFile, downloadRelease, applyUpdate, buildApplyScript, isPortable, resolveRepos, DEFAULT_REPOS };
