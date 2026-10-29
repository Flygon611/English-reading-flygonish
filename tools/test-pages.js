#!/usr/bin/env node
/* GitHub Pages 部署验收：把 dist/ 挂在子路径下跑一遍，模拟 https://<user>.github.io/<repo>/
 *
 * 用法：node tools/test-pages.js [--dist] [--port 8801]
 * 覆盖：子路径资源加载、字体、示例文本、查词、无 404 / 无控制台错误、首屏传输量。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const DIST = path.join(ROOT, 'dist');
const PORT = 8801;
const PREFIX = '/deepread/';           // 模拟仓库名
const LIVE = (() => { const i = process.argv.indexOf('--url'); return i >= 0 ? String(process.argv[i + 1] || '') : ''; })();
const URL_BASE = LIVE ? (LIVE.replace(/\/+$/, '') + '/') : ('http://127.0.0.1:' + PORT + PREFIX);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  → ' + String(detail).slice(0, 120) : ''));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP ' + msg.error.message)); else resolve(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
      }, timeoutMs || 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内报错：' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  }
  take(method) { return this.events.filter((e) => e.method === method); }
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init || {});
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

(async () => {
  if (!LIVE && !fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('没有 dist/：先跑 node tools/build-site.js');
    process.exit(2);
  }
  if (!fs.existsSync(EDGE)) { console.error('找不到 Edge'); process.exit(2); }

  /* 1. 起一个带 /deepread/ 前缀的静态服务器，模拟 Pages 子路径 */
  const server = LIVE ? null : spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(PORT), '--root', DIST, '--prefix', PREFIX], { stdio: 'ignore' });
  if (!LIVE) await sleep(600);

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-pages-'));
  let cdpPort = 9391;
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + userDir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--force-device-scale-factor=1', '--window-size=1440,960', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const v = await fetchJSON('http://127.0.0.1:' + cdpPort + '/json/version');
        if (v && v.webSocketDebuggerUrl) target = v;
      } catch (e) {}
    }
    const t = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 失败')));
      setTimeout(() => rej(new Error('WebSocket 超时')), 15000);
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    const consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception');
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push('console.error');
    });
    await cdp.send('Page.navigate', { url: URL_BASE });

    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await sleep(200);
      try { ready = await cdp.ev('!!(window.DR && DR.reader && DR.dict && DR.store)'); } catch (e) {}
    }
    check('子路径下应用能启动', ready, URL_BASE);

    /* 资源状态：所有请求都应 2xx/3xx */
    await sleep(1200);
    const responses = cdp.take('Network.responseReceived').map((e) => e.params.response);
    const bad = responses.filter((r) => r.status >= 400).map((r) => r.status + ' ' + r.url);
    check('没有 404 / 失败请求', bad.length === 0, bad.slice(0, 3).join(' | '));

    const examRe = new RegExp(URL_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'js/data/exam\\.js$');
    const jsOk = responses.some((r) => examRe.test(r.url) && r.status === 200);
    check('词库脚本走子路径加载成功', jsOk, responses.filter((r) => /exam\.js/.test(r.url)).map((r) => r.status).join(','));

    /* 字体：浏览器里确实用上了自托管字体 */
    const fontOk = await cdp.ev('(function(){try{return document.fonts.check("16px Fraunces") && document.fonts.check("16px Newsreader");}catch(e){return false;}})()');
    check('Fraunces / Newsreader 字体已加载', fontOk === true, String(fontOk));

    /* EB Garamond：完整可变字体（2 个文件约 1.6 MB）也要随站点发出去，且 dlig 要打开 */
    await cdp.ev('(function(){var s=DR.store.settings();s.readFont="garamond";DR.store.saveSettings(s);DR.settings.apply();return true;})()');
    let gara = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      gara = await cdp.ev('(function(){try{var a=document.querySelector("#article-body");var cs=a?getComputedStyle(a):null;return {check:document.fonts.check(\'20px "EB Garamond"\'), fam:cs?cs.fontFamily:"", ffs:cs?cs.fontFeatureSettings:""};}catch(e){return null;}})()');
      if (gara && gara.check) break;
    }
    check('线上 EB Garamond 可加载且 dlig 已打开', !!gara && gara.check === true && /EB Garamond/.test(gara.fam || '') && /dlig/i.test(gara.ffs || ''), JSON.stringify(gara));
    await cdp.ev('(function(){var s=DR.store.settings();s.readFont="newsreader";DR.store.saveSettings(s);DR.settings.apply();return true;})()');

    /* 示例文本 + 查词 */
    await cdp.ev('(function(){var b=document.querySelector("#btn-load-sample"); if(b) b.click(); return true;})()');
    await sleep(700);
    const sample = await cdp.ev('(function(){var t=document.querySelector("#article-title");var n=document.querySelectorAll("#article-body .w").length;return {title:t?t.textContent:"",words:n};})()');
    check('示例文章能载入', !!sample && sample.words > 100, JSON.stringify(sample));

    const lookup = await cdp.ev('(function(){var e=DR.dict.resolve("deliberating");return e?{w:e.entry.w,zh:e.entry.zh}:null;})()');
    check('查词可用（deliberating → deliberate）', !!lookup && /de?liberat/i.test(lookup.w || ''), lookup && lookup.w);

    /* 首屏传输量（encodedDataLength 之和） */
    const reqs = cdp.take('Network.loadingFinished');
    const respById = new Map(cdp.take('Network.requestWillBeSent').map((e) => [e.params.requestId, e.params.request.url]));
    let bytes = 0;
    reqs.forEach((e) => {
      const u = respById.get(e.params.requestId) || '';
      if (u.indexOf(URL_BASE) !== 0) return;
      bytes += e.params.encodedDataLength || 0;
    });
    check('首屏传输量 < 20 MB', bytes > 0 && bytes < 20 * 1024 * 1024, (bytes / 1048576).toFixed(1) + ' MB');

    check('无未捕获脚本错误', consoleErrors.length === 0, consoleErrors.length + ' 个');
  } finally {
    try { edge.kill(); } catch (e) {}
    try { if (server) server.kill(); } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' 项断言，' + failed.length + ' 失败');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试环境失败：' + e.message); process.exit(2); });
