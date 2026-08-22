import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'platform', 'tauri', 'dist');
fs.mkdirSync(dist, { recursive: true });

for (const file of ['loading.html', 'onboarding.html', 'recovery-center.html', 'icon.png']) {
  fs.copyFileSync(path.join(root, 'assets', file), path.join(dist, file));
}

const aboutPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>关于 Deepseek Harness EAC</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#dbe4f0;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{width:420px;margin:0 auto;padding:28px 24px}h1{font-size:19px;margin:0 0 4px}h2{font-size:13px;color:#8ea3c8;font-weight:400;margin:0 0 22px}.row{display:flex;gap:16px;margin:9px 0}.label{width:88px;color:#8ea3c8}.value{flex:1;word-break:break-word}.links{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}button{padding:7px 11px;border:1px solid #2c4370;border-radius:6px;background:#1b2c4a;color:#dbe4f0;cursor:pointer}button:hover{background:#24375c}#status{min-height:1.5em;color:#9fe6c0;margin-top:10px}</style></head><body><main><h1>Deepseek Harness EAC</h1><h2>桌面客户端</h2><div class="row"><span class="label">客户端</span><span class="value" id="app">-</span></div><div class="row"><span class="label">agent</span><span class="value" id="agent">-</span></div><div class="row"><span class="label">桌面壳</span><span class="value" id="shell">Tauri</span></div><div class="links"><button data-copy="github">复制 GitHub 地址</button><button data-copy="gitee">复制 Gitee 地址</button><button id="close">关闭</button></div><div id="status"></div></main><script>'use strict';(async function(){let b=window.about;for(let n=0;!b&&n<40;n++){await new Promise(r=>setTimeout(r,50));b=window.about}const esc=v=>String(v==null?'':v);if(!b){document.getElementById('status').textContent='About bridge 不可用';return}const i=await b.info();document.getElementById('app').textContent=esc(i.appVersion);document.getElementById('agent').textContent=esc(i.agentVersion||'未知');document.getElementById('shell').textContent=esc(i.desktopShell||'tauri');for(const x of document.querySelectorAll('[data-copy]'))x.onclick=async()=>{const u=i.repoUrls&&i.repoUrls[x.dataset.copy];const r=await b.copy(String(u||''));document.getElementById('status').textContent=r&&r.ok?'地址已复制':'复制失败'};document.getElementById('close').onclick=()=>b.close()})().catch(e=>{document.getElementById('status').textContent=String(e)})</script></body></html>`;
fs.writeFileSync(path.join(dist, 'about.html'), aboutPage, 'utf8');

const updatePage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deepseek Harness EAC 更新</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b1220;color:#dbe4f0;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}
main{width:min(680px,calc(100vw - 40px));margin:0 auto;padding:28px 0}header{display:flex;align-items:center;gap:10px;border-bottom:1px solid #243756;padding-bottom:16px}h1{font-size:20px;margin:0;flex:1}header span{color:#8ea3c8;font-size:12px}section{padding:22px 0;border-bottom:1px solid #1d2a44}.row{display:flex;justify-content:space-between;gap:16px;margin:8px 0}.label{color:#8ea3c8}.value{font-family:Consolas,monospace;text-align:right;word-break:break-word}#status{min-height:2em;color:#9fe6c0}#status.err{color:#ff9db0}.progress{height:8px;background:#16233c;border-radius:4px;overflow:hidden;margin-top:14px}.progress i{display:block;height:100%;width:0;background:#5b8cff;transition:width .2s}.actions{display:flex;justify-content:flex-end;gap:8px;padding-top:18px}button{padding:8px 14px;border:1px solid #2c4370;border-radius:6px;background:#1b2c4a;color:#dbe4f0;cursor:pointer}button.primary{background:#3569d4;border-color:#5b8cff}button:disabled{opacity:.5;cursor:default}
</style></head><body><main><header><h1>Deepseek Harness EAC 更新</h1><span id="kind">等待连接</span></header>
<section><div class="row"><span class="label">当前版本</span><span class="value" id="current">-</span></div><div class="row"><span class="label">目标版本</span><span class="value" id="latest">-</span></div><div class="row"><span class="label">状态</span><span class="value" id="status">正在连接 desktop-host…</span></div><div class="progress"><i id="progress"></i></div></section>
<div class="actions"><button id="close">关闭</button><button id="check">检查更新</button><button id="cancel" disabled>取消</button><button class="primary" id="apply" disabled>安装 agent 更新</button></div></main>
<script>
'use strict';
(async function(){
  const $=id=>document.getElementById(id); let bridge=window.update; let currentState=null;
  for(let i=0;!bridge&&i<40;i++){await new Promise(r=>setTimeout(r,50));bridge=window.update}
  if(!bridge){$('status').textContent='更新 bridge 不可用';$('status').className='err';return}
  $('kind').textContent=bridge.kind==='client'?'客户端':'agent';
  const labels={idle:'等待检查',checking:'正在检查…',current:'已是最新版本',available:'发现新版本',unsupported:'当前平台不支持应用内更新',starting:'准备更新…',running:'正在更新…',ready:'更新已安装',cancelled:'更新已取消',failed:'更新失败'};
  function render(s){
    currentState=s;
    $('current').textContent=s.currentVersion||'-';$('latest').textContent=s.latestVersion||'-';
    $('status').textContent=s.message||labels[s.state]||s.state;$('status').className=s.state==='failed'?'err':'';
    $('apply').disabled=bridge.kind!=='agent'||s.state!=='available';
    $('check').disabled=s.state==='checking'||s.state==='running'||s.state==='starting';
    $('cancel').disabled=s.state!=='starting'&&s.state!=='running';
    const p=s.progress||{}; const pct=p.total>0?Math.min(100,Math.round((p.received||0)*100/p.total)):s.state==='ready'?100:0;$('progress').style.width=pct+'%';
  }
  bridge.onState(render);render(await bridge.state());
  $('check').onclick=async()=>render(await bridge.check());
  $('apply').onclick=async()=>{const r=await bridge.apply();if(!r||r.ok===false){$('status').textContent=(r&&r.error)||'启动更新失败';$('status').className='err'}};
  $('cancel').onclick=async()=>{if(currentState&&currentState.jobId)await bridge.cancel(currentState.jobId)};
  $('close').onclick=()=>bridge.close();
  render(await bridge.check());
})();
</script></body></html>`;
fs.writeFileSync(path.join(dist, 'update.html'), updatePage, 'utf8');
