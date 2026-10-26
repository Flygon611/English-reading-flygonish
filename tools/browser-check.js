#!/usr/bin/env node
/* 深读 DeepRead · 浏览器验收（qa-verify）
 *
 * 用 Edge 调试端口把站点真跑一遍：不依赖 puppeteer，只用 Node 24 内置 WebSocket / fetch。
 * 覆盖：file://（双击场景）与 http://127.0.0.1:8787/ 两种入口、#/read #/notebook #/dict 三个路由、
 *       console 错误 / 未捕获异常 / 失败请求 / 契约 DOM 存在性 / 横向溢出（1440 与 420 两档宽度），
 *       产物截图写入 preview/，报告写入 preview/browser-check.json。
 *
 * 用法：
 *   node tools/browser-check.js                 # file + http 都跑
 *   node tools/browser-check.js --base file     # 只跑 file://
 *   node tools/browser-check.js --base http     # 只跑 http://127.0.0.1:8787/
 *   node tools/browser-check.js --shots 0       # 不截图
 *   node tools/browser-check.js --selftest      # 用临时页面验证测试工具链本身（不需要应用）
 *
 * 退出码：0 全绿 / 1 有失败项 / 2 环境阻塞（找不到应用或 Edge）
 * 环境变量：EDGE_PATH 覆盖浏览器路径；DR_CDP_PORT 调试端口；DR_PORT 本地服务端口。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'preview');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE_BASE = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
const HTTP_PORT = Number(process.env.DR_PORT || 8787);
const HTTP_BASE = 'http://127.0.0.1:' + HTTP_PORT + '/';
const CDP_PORT = Number(process.env.DR_CDP_PORT || 9223);
/* 端口占用时会自动往后找空闲端口（旧 Edge 残留不至于让本次连到陈旧实例） */
let cdpPort = CDP_PORT;
const ROUTES = [
  { name: 'read', hash: '#/read' },
  { name: 'notebook', hash: '#/notebook' },
  { name: 'dict', hash: '#/dict' },
];

/* 每个路由必须存在的元素（契约 §5）。做成路由级，避免把「懒创建」的弹窗误判为缺失。 */
const ROUTE_CONTRACT = {
  read: ['library', 'library-list', 'btn-new-article'],
  notebook: ['notebook-list', 'notebook-stats', 'notebook-search', 'notebook-filter', 'btn-review'],
  dict: ['dict-search', 'dict-result'],
};
/* 始终必须在骨架里的元素 */
const SHELL_CONTRACT = ['app', 'tabs', 'tab-reader', 'tab-notebook', 'tab-dict', 'theme-toggle', 'toast-layer'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const hasFlag = (name) => process.argv.indexOf('--' + name) >= 0;

/* ------------------------------------------------------------------ CDP */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP ' + msg.method + ' 失败：' + msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      this.events.push(msg);
      if (this.events.length > 4000) this.events.splice(0, 2000);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].method === msg.method) {
          const w = this.waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg.params);
        }
      }
      if (this.onEvent) this.onEvent(msg);
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时 ' + (timeoutMs || 20000) + 'ms：' + method));
        }
      }, timeoutMs || 20000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('页面内报错：' + String(detail).split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  }
  waitEvent(method, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs || 10000);
      this.waiters.push({ method, resolve, timer });
    });
  }
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init || {});
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

async function waitCDP(port, ms) {
  const deadline = Date.now() + (ms || 20000);
  while (Date.now() < deadline) {
    try {
      const v = await fetchJSON('http://127.0.0.1:' + port + '/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  return null;
}

async function newTarget(port) {
  const url = 'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank');
  try {
    const r = await fetch(url, { method: 'PUT' });
    if (r.ok) return await r.json();
  } catch (e) { /* 老版本只支持 GET */ }
  return fetchJSON(url);
}

/* --------------------------------------------------------------- 采集器 */

class Collector {
  constructor() {
    this.reset();
  }
  reset() {
    this.consoleErrors = [];
    this.exceptions = [];
    this.failedRequests = [];
    this.httpErrors = [];
    this.dialogs = [];
  }
  attach(cdp) {
    cdp.onEvent = (msg) => {
      const p = msg.params || {};
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {};
        const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
        this.exceptions.push(String(desc).split('\n').slice(0, 3).join(' | '));
      } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        const txt = (p.args || []).map((a) => (a.value !== undefined ? a.value : a.description || '')).join(' ');
        this.consoleErrors.push(String(txt).slice(0, 400));
      } else if (msg.method === 'Log.entryAdded' && p.entry && p.entry.level === 'error') {
        const e = p.entry;
        this.consoleErrors.push(String(e.text || '').slice(0, 300) + (e.url ? ' @ ' + e.url : ''));
      } else if (msg.method === 'Network.responseReceived') {
        const r = p.response || {};
        if (r.status >= 400) this.httpErrors.push({ status: r.status, url: r.url });
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push({ type: p.type, message: p.message });
      }
    };
    // 请求 id → url 映射，供 loadingFailed 用
    const map = new Map();
    cdp.send('Network.enable').catch(() => {});
    const base = cdp.onEvent;
    cdp.onEvent = (msg) => {
      if (msg.method === 'Network.requestWillBeSent') {
        const p = msg.params || {};
        map.set(p.requestId, p.request && p.request.url);
      } else if (msg.method === 'Network.loadingFailed') {
        const p = msg.params || {};
        const url = map.get(p.requestId) || '';
        if (!/favicon/i.test(url)) {
          this.failedRequests.push({ url, error: p.errorText, type: p.type });
        }
        return;
      }
      base(msg);
    };
    cdp.send('Log.enable').catch(() => {});
  }
  /* 一些噪声：file:// 下 favicon、DevTools 自身请求 —— 不算站点缺陷 */
  filtered() {
    const noise = /favicon|devtools|chrome-extension/i;
    return {
      exceptions: this.exceptions,
      console: this.consoleErrors.filter((s) => !noise.test(s)),
      failed: this.failedRequests.filter((r) => !noise.test(r.url)),
      http: this.httpErrors.filter((r) => !noise.test(r.url)),
    };
  }
  count() { return this.exceptions.length + this.consoleErrors.length + this.failedRequests.length; }
}

/* ------------------------------------------------------------ 页面探测 */

const PROBE_JS = `(function () {
  var de = document.documentElement;
  var R = {};
  R.href = location.href;
  R.hash = location.hash;
  R.readyState = document.readyState;
  R.title = document.title;
  R.innerWidth = window.innerWidth;
  R.innerHeight = window.innerHeight;
  R.scrollWidth = de.scrollWidth;
  R.bodyScrollWidth = document.body ? document.body.scrollWidth : 0;
  R.overflow = Math.max(0, de.scrollWidth - window.innerWidth);
  R.hasApp = !!document.getElementById('app');
  R.tabCount = document.querySelectorAll('#tabs > *').length;
  R.tabsExist = ['tab-reader', 'tab-notebook', 'tab-dict'].map(function (id) { return !!document.getElementById(id); });
  R.dr = {
    DR: typeof window.DR,
    text: !!(window.DR && window.DR.text),
    dict: !!(window.DR && window.DR.dict),
    analyze: !!(window.DR && window.DR.analyze),
    debug: !!(window.DR && window.DR.debug)
  };
  R.theme = de.getAttribute('data-theme') || '';
  R.lsKeys = (function () {
    var ks = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('dr.') === 0) ks.push(k); } } catch (e) {}
    return ks;
  })();
  R.appTextLen = (function () { var a = document.getElementById('app'); return a ? (a.innerText || '').trim().length : 0; })();
  /* 自托管字体（契约 §7 v1.1）：6 个字体面必须全部 loaded，file:// 也算 */
  R.fonts = (function () {
    var faces = [];
    try {
      if (document.fonts && document.fonts.forEach) {
        document.fonts.forEach(function (f) {
          faces.push({
            family: String(f.family || '').replace(/["']/g, ''),
            weight: String(f.weight || ''),
            status: String(f.status || '')
          });
        });
      }
    } catch (e) {}
    var fams = ['Fraunces', 'Newsreader', 'Inter', 'WenKaiCN', 'Literata', 'JetBrains Mono'];
    var checks = {};
    fams.forEach(function (f) {
      try { checks[f] = !!(document.fonts && document.fonts.check('16px "' + f + '"')); }
      catch (e) { checks[f] = false; }
    });
    var reqs = [];
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        if (/\\.(woff2?|ttf)(\\?|#|$)/i.test(e.name)) {
          reqs.push({ file: e.name.split('/').pop(), size: e.transferSize || 0 });
        }
      });
    } catch (e) {}
    return {
      status: document.fonts ? document.fonts.status : 'n/a',
      faceCount: faces.length,
      faces: faces.slice(0, 24),
      checks: checks,
      requests: reqs,
      readFont: document.documentElement.getAttribute('data-read-font') || ''
    };
  })();
  R.articleWidth = (function () { var a = document.getElementById("article-body"); return a ? Math.round(a.getBoundingClientRect().width) : 0; })();
  /* 页面自己捕获的错误（index.html 里挂了 window.error / unhandledrejection） */
  R.drErrors = (function () { try { return (window.__drErrors || []).slice(0, 10); } catch (e) { return []; } })();
  R.articleLen = (function () { var a = document.getElementById('article-body'); return a ? (a.innerText || '').trim().length : 0; })();
  R.emptyState = !!document.querySelector('#article-body .empty, #article-body .placeholder, #library .empty, .empty-state');
  R.viewportMeta = (function () {
    var m = document.querySelector('meta[name="viewport"]');
    return m ? (m.getAttribute('content') || '') : '';
  })();
  R.contract = {};
  ['app','tabs','tab-reader','tab-notebook','tab-dict','theme-toggle','settings-open','settings-modal',
   'library','library-list','btn-new-article','paste-modal','paste-text','paste-title','btn-paste-start',
   'article-body','article-meta','article-title','btn-save-article','btn-delete-article','inspector',
   'word-card','sentence-card','btn-add-word','btn-speak-word','notebook-list','notebook-stats',
   'notebook-search','notebook-filter','btn-review','review-modal','review-card','review-reveal',
   'btn-rate-1','btn-rate-2','btn-rate-3','dict-search','dict-result','toast-layer'
  ].forEach(function (id) { R.contract[id] = !!document.getElementById(id); });
  R.activeTab = (function () {
    var tabs = [].slice.call(document.querySelectorAll('#tabs > *'));
    var act = tabs.filter(function (t) {
      return t.getAttribute('aria-selected') === 'true' ||
        /(?:^|\\s)(active|is-active|on|current|selected)(?:\\s|$)/.test(t.className || '');
    });
    return act.map(function (t) { return t.id || (t.textContent || '').trim(); });
  })();
  R.visibleOverlays = [].slice.call(document.querySelectorAll('[id$="-modal"], dialog[open]')).filter(function (m) {
    var s = getComputedStyle(m);
    var r = m.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }).map(function (m) { return m.id || m.className; });
  return R;
})()`;

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const selftest = hasFlag('selftest');
  const baseArg = String(arg('base', 'both'));
  const wantShots = String(arg('shots', '1')) !== '0';
  const themePref = String(arg('theme', 'light'));
  const report = {
    v: 1,
    kind: 'browser-check',
    at: new Date().toISOString(),
    env: { node: process.version, platform: process.platform, edge: EDGE, cdpPort: cdpPort, root: ROOT },
    status: 'running',
    bases: [],
    defects: [],
    shots: [],
    summary: {},
  };
  const defects = report.defects;
  const addDefect = (d) => { defects.push(Object.assign({ id: 'D' + String(defects.length + 1).padStart(2, '0') }, d)); return defects[defects.length - 1].id; };

  fs.mkdirSync(PREVIEW, { recursive: true });

  const appPath = path.join(ROOT, 'index.html');
  if (!selftest && !fs.existsSync(appPath)) {
    report.status = 'blocked';
    report.blockedReason = 'index.html 不存在（应用还没落地）';
    report.summary = { passed: 0, failed: 0, note: report.blockedReason };
    fs.writeFileSync(path.join(PREVIEW, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.log('阻塞：' + report.blockedReason + '（file:// 目标 ' + FILE_BASE + '）');
    return 2;
  }
  if (!fs.existsSync(EDGE)) {
    report.status = 'blocked';
    report.blockedReason = '找不到 Edge：' + EDGE;
    report.summary = { passed: 0, failed: 0, note: report.blockedReason };
    fs.writeFileSync(path.join(PREVIEW, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.log('阻塞：' + report.blockedReason);
    return 2;
  }

  /* 自检模式：写一个临时页面，验证「启动→探测→双档截图→JSON」整条链路 */
  let tempDir = null;
  let bases;
  if (selftest) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-selftest-'));
    const p = path.join(tempDir, 'index.html');
    fs.writeFileSync(p, '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>SELFTEST</title></head>' +
      '<body><div id="app"><div id="tabs"><button id="tab-reader">阅读</button><button id="tab-notebook">生词本</button><button id="tab-dict">词库</button></div>' +
      '<div id="library"><div id="library-list"></div></div><div id="article-body">selftest body text</div><div id="dict-search"></div><div id="dict-result"></div>' +
      '<div id="notebook-list"></div><div id="notebook-stats">0</div><div id="notebook-search"></div><div id="notebook-filter"></div>' +
      '<button id="btn-review"></button><button id="theme-toggle"></button><button id="btn-new-article"></button>' +
      '<div id="toast-layer"></div></div><script>window.DR={text:{tokenize:function(){return[]}}};</script></body></html>');
    bases = [{ name: 'selftest', url: 'file:///' + p.replace(/\\/g, '/') }];
    console.log('自检模式：临时页面 ' + p);
  } else if (baseArg === 'file') {
    bases = [{ name: 'file', url: FILE_BASE }];
  } else if (baseArg === 'http') {
    bases = [{ name: 'http', url: HTTP_BASE }];
  } else {
    bases = [{ name: 'file', url: FILE_BASE }, { name: 'http', url: HTTP_BASE }];
  }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-edge-'));
  let serverChild = null;
  let edge = null;
  let exitCode = 0;

  const started = Date.now();
  try {
    /* 找空闲调试端口：避免连到上一次残留的 Edge 实例 */
    for (let i = 0; i < 8; i++) {
      let busy = false;
      try {
        await fetchJSON('http://127.0.0.1:' + cdpPort + '/json/version', { signal: AbortSignal.timeout(400) });
        busy = true;
      } catch (e) { busy = false; }
      if (!busy) break;
      console.log('端口 ' + cdpPort + ' 已被占用，改用 ' + (cdpPort + 1));
      cdpPort += 1;
    }

    /* 本地服务器：优先用已在跑的，没有再自己拉起 tools/serve.js */
    if (bases.some((b) => b.name === 'http')) {
      let up = false;
      /* 健康检查只判 HTTP 状态，别用 fetchJSON（HTML 不是 JSON） */
      for (let i = 0; i < 5 && !up; i++) {
        try { const r = await fetch(HTTP_BASE, { signal: AbortSignal.timeout(2500) }); up = r.ok; } catch (e) { await sleep(300); }
      }
      if (!up) {
        const serve = path.join(ROOT, 'tools', 'serve.js');
        if (fs.existsSync(serve)) {
          serverChild = spawn(process.execPath, [serve, String(HTTP_PORT)], { cwd: ROOT, stdio: 'ignore' });
          for (let i = 0; i < 40 && !up; i++) {
            await sleep(150);
            try { const r = await fetch(HTTP_BASE, { signal: AbortSignal.timeout(1500) }); up = r.ok; } catch (e) { /* 等待 */ }
          }
        }
      }
      report.httpServer = up ? 'ok' : 'unavailable';
      if (!up) {
        console.log('警告：http://127.0.0.1:' + HTTP_PORT + '/ 不可用（tools/serve.js 缺失或未启动），跳过 http 入口');
        bases = bases.filter((b) => b.name !== 'http');
        addDefect({ severity: 'warn', area: 'env', selector: 'http://127.0.0.1:' + HTTP_PORT + '/', expected: '本地 http 入口可访问', actual: '连接失败且无法由 tools/serve.js 启动', shot: '' });
      }
    }

    edge = spawn(EDGE, [
      '--headless=new',
      '--remote-debugging-port=' + cdpPort,
      '--user-data-dir=' + userDir,
      '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--hide-scrollbars',
      '--disable-extensions', '--disable-background-networking',
      '--disable-sync', '--disable-component-update',
      '--force-device-scale-factor=1',
      '--window-size=1440,960',
      'about:blank',
    ], { stdio: 'ignore' });
    edge.on('error', (e) => console.error('Edge 启动失败：' + e.message));

    const ver = await waitCDP(cdpPort, 20000);
    if (!ver) throw new Error('Edge 调试端口 ' + cdpPort + ' 没起来');
    report.env.browser = ver.Browser || '';
    console.log('Edge 已连接：' + (ver.Browser || ''));

    const target = await newTarget(cdpPort);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
      setTimeout(() => rej(new Error('WebSocket 连接超时')), 15000);
    });
    const cdp = new CDP(ws);
    const col = new Collector();
    col.attach(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    /* 弹窗自动放行（应用可能有 confirm） */
    const origOnEvent = cdp.onEvent;
    cdp.onEvent = (msg) => {
      origOnEvent(msg);
      if (msg.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    };

    /* 高负载下 CDP 偶发超时：重试 + 更长超时；且把「工具失败」与「应用缺陷」分开记 */
    const safeSend = async (method, params, timeoutMs, tries) => {
      let lastErr = null;
      const n = tries || 2;
      for (let i = 0; i < n; i++) {
        try { return await cdp.send(method, params, timeoutMs || 30000); }
        catch (e) { lastErr = e; await sleep(500); }
      }
      throw lastErr;
    };
    const toolFailures = [];

    const shotName = (s) => path.join(PREVIEW, s + '.png');
    const capture = async (name) => {
      if (!wantShots) return '';
      try {
        const r = await safeSend('Page.captureScreenshot', { format: 'png' }, 45000, 2);
        const file = shotName(name);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        report.shots.push(file);
        return file;
      } catch (e) {
        toolFailures.push({ kind: 'screenshot', name: name, error: e.message });
        console.log('  截图失败 ' + name + '（工具层，非应用缺陷）：' + e.message);
        return '';
      }
    };

    const goto = async (url) => {
      await cdp.send('Page.navigate', { url });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await sleep(120);
        try {
          const st = await cdp.evaluate('document.readyState');
          if (st === 'complete') break;
        } catch (e) { /* 上下文在切换 */ }
      }
      await sleep(350);
    };

    const setHash = async (hash) => {
      try {
        await cdp.evaluate('(function(){ location.hash = ' + JSON.stringify(hash) + '; return location.hash; })()');
      } catch (e) { /* 忽略 */ }
      await sleep(450);
    };

    const setViewport = async (w, h) => {
      /* mobile:false —— 要的是真实的 420 CSS px 布局视口（浏览器窗口缩窄），
         不是带 980px 布局视口的手机仿真；否则「窄屏无横向溢出」这条等于没测。 */
      try {
        await safeSend('Emulation.setDeviceMetricsOverride', {
          width: w, height: h, deviceScaleFactor: 1, mobile: false,
        }, 20000, 3);
        await sleep(250);
        return true;
      } catch (e) {
        toolFailures.push({ kind: 'viewport', error: e.message, size: w + 'x' + h });
        console.log('  视口设置失败（工具层，非应用缺陷）：' + e.message);
        return false;
      }
    };
    const clearViewport = async () => {
      try { await safeSend('Emulation.clearDeviceMetricsOverride', {}, 15000, 2); } catch (e) { /* 忽略 */ }
      await sleep(200);
    };

    for (const base of bases) {
      if (!base.url) continue;
      const baseReport = { name: base.name, url: base.url, entry: null, routes: [], ok: true };
      report.bases.push(baseReport);
      console.log('\n=== 入口 ' + base.name + '：' + base.url + ' ===');

      col.reset();
      await goto(base.url);
      await setViewport(1440, 960);
      /* 固定主题再截图：headless 默认跟随系统会是深色，统一成浅色便于看版式（深色由 ui-test T7 覆盖） */
      if (themePref === 'light' || themePref === 'dark') {
        try {
          await cdp.evaluate('(function(){try{var k="dr.settings.v1"; var s=JSON.parse(localStorage.getItem(k)||"{}"); s.v=s.v||1; s.theme="' + themePref + '"; localStorage.setItem(k, JSON.stringify(s)); return true;}catch(e){return false;}})()');
          await cdp.send('Page.reload');
          const dl = Date.now() + 12000;
          while (Date.now() < dl) {
            await sleep(120);
            try { if ((await cdp.evaluate('document.readyState')) === 'complete') break; } catch (e) { /* 切换中 */ }
          }
          await sleep(400);
        } catch (e) { /* 主题设置失败不影响验收 */ }
      }
      /* 主动触发 6 个自托管字体加载（Literata 等只在选中时用，懒加载；不主动 load 就永远是 unloaded），
         再等 document.fonts.ready（带 6s 上限） */
      try {
        await cdp.evaluate('(function(){ if(!document.fonts) return Promise.resolve(true); var fams=["Fraunces","Newsreader","Inter","WenKaiCN","Literata","JetBrains Mono"]; return Promise.all(fams.map(function(f){ return document.fonts.load("16px \\"" + f + "\\"").catch(function(){ return null; }); })).then(function(){ return Promise.race([document.fonts.ready, new Promise(function(r){ setTimeout(r, 6000); })]); }).then(function(){ return true; }); })()');
      } catch (e) { /* 忽略 */ }
      await sleep(400);

      /* 入口页（无 hash）也要能启动 */
      let entry;
      try { entry = await cdp.evaluate(PROBE_JS); } catch (e) { entry = { error: e.message }; }
      const entryErrors = {
        exceptions: col.exceptions.slice(),
        console: col.consoleErrors.filter((s) => !/favicon/i.test(s)),
        failed: col.failedRequests.filter((r) => !/favicon/i.test(r.url)),
        http: col.httpErrors.slice(),
      };
      baseReport.entry = { probe: entry, errors: entryErrors };
      const entryErrCount = entryErrors.exceptions.length + entryErrors.console.length +
        entryErrors.failed.length + entryErrors.http.length;
      baseReport.entry.shot = await capture('bc-' + base.name + '-entry-1440');
      if (!entry || !entry.hasApp) {
        baseReport.ok = false;
        baseReport.entry.ok = false;
        addDefect({
          severity: 'fail', base: base.name, route: 'entry', selector: '#app',
          expected: '入口页渲染出应用根 #app', actual: entry ? ('hasApp=' + entry.hasApp + ' readyState=' + entry.readyState) : ('探测失败 ' + entry.error),
          shot: baseReport.entry.shot,
        });
        console.log('✗ 入口：' + (entry && entry.error ? entry.error : '#app 缺失'));
      } else {
        baseReport.entry.ok = entryErrCount === 0;
        console.log((baseReport.entry.ok ? '✓' : '✗') + ' 入口渲染（#app, ' + entry.tabCount + ' 个 TAB, DR=' + entry.dr.DR + '）错误 ' + entryErrCount + ' 条');
      }
      /* 全量契约元素缺失（骨架级 → 失败；懒创建 → 警告） */
      const missingShell = SHELL_CONTRACT.filter((id) => entry && entry.contract && !entry.contract[id]);
      if (missingShell.length) {
        baseReport.ok = false;
        addDefect({
          severity: 'fail', base: base.name, route: 'entry', selector: missingShell.map((i) => '#' + i).join(', '),
          expected: '契约 §5 骨架元素存在', actual: '缺失：' + missingShell.join(', '),
          shot: baseReport.entry.shot,
        });
      }
      /* 自托管字体（契约 §7 v1.1）：6 个字体面必须全部 loaded；file:// 下也要能加载 */
      const fontInfo = entry && entry.fonts;
      if (fontInfo) {
        const checks = fontInfo.checks || {};
        const required = ['Fraunces', 'Newsreader', 'Inter', 'WenKaiCN', 'Literata', 'JetBrains Mono'];
        /* 以字体面状态为准（主动 load 过之后应当全是 loaded）；check() 只作记录 */
        const faceByFam = {};
        (fontInfo.faces || []).forEach((f) => { faceByFam[String(f.family).replace(/["']/g, '')] = f.status; });
        const missing = required.filter((f) => faceByFam[f] !== 'loaded');
        const badFaces = (fontInfo.faces || []).filter((f) => f.status === 'error');
        baseReport.fonts = {
          checks: checks, faceCount: fontInfo.faceCount, status: fontInfo.status,
          requests: fontInfo.requests, readFont: fontInfo.readFont,
          missing: missing, badFaces: badFaces.map((f) => f.family + '/' + f.status),
        };
        if (missing.length || badFaces.length) {
          baseReport.ok = false;
          addDefect({
            severity: 'fail', base: base.name, route: 'entry', selector: '@font-face',
            expected: 'Fraunces/Newsreader/Inter/WenKaiCN/Literata/JetBrains Mono 六个字体面全部 loaded',
            actual: '未就绪：' + (missing.join(', ') || '（无）') + '；未加载面：' + (badFaces.map((f) => f.family + '/' + f.status).join(', ') || '（无）') +
              '；请求数 ' + ((fontInfo.requests || []).length),
            shot: baseReport.entry.shot,
          });
          console.log('  ✗ 字体未全部加载：' + (missing.join(',') || badFaces.map((f) => f.family + '/' + f.status).join(',')));
        } else {
          console.log('  ✓ 字体加载：' + (fontInfo.faceCount || 0) + ' 个字体面全部 loaded，' + ((fontInfo.requests || []).length) + ' 个字体请求，readFont=' + fontInfo.readFont);
        }
      }
      /* 窄屏可用的前提：真机宽度生效。缺 viewport meta 时 420px 实测通过也不代表手机上对 */
      if (entry && !entry.error && !/width\s*=\s*device-width/i.test(entry.viewportMeta || '')) {
        addDefect({
          severity: 'warn', base: base.name, route: 'entry', selector: 'meta[name="viewport"]',
          expected: 'width=device-width，使真机按设备宽度布局',
          actual: entry.viewportMeta ? ('content="' + entry.viewportMeta + '"') : '缺少 viewport meta',
          shot: baseReport.entry.shot,
        });
        console.log('  ⚠ 缺 viewport meta：真手机不会按 420px 布局（桌面窗口缩窄仍按 CSS 生效）');
      }

      for (const route of ROUTES) {
        const rr = { name: route.name, hash: route.hash, ok: true, desktop: null, narrow: null, errors: null, shots: [] };
        baseReport.routes.push(rr);
        col.reset();
        await goto(base.url);
        await setViewport(1440, 960);
        await setHash(route.hash);
        await sleep(300);

        let probe;
        try { probe = await cdp.evaluate(PROBE_JS); } catch (e) { probe = { error: e.message }; }
        const errs = {
          exceptions: col.exceptions.slice(),
          console: col.consoleErrors.filter((s) => !/favicon/i.test(s)),
          failed: col.failedRequests.filter((r) => !/favicon/i.test(r.url)),
          http: col.httpErrors.slice(),
        };
        const errCount = errs.exceptions.length + errs.console.length + errs.failed.length + errs.http.length;
        rr.errors = errs;
        rr.desktop = probe;
        rr.shotDesktop = await capture('bc-' + base.name + '-' + route.name + '-1440');
        rr.shots.push(rr.shotDesktop);

        const problems = [];
        if (!probe || probe.error) problems.push('探测失败：' + (probe && probe.error));
        else {
          if (probe.hash !== route.hash) problems.push('hash 未生效（' + probe.hash + ' ≠ ' + route.hash + '）');
          if (!probe.hasApp) problems.push('#app 缺失');
          if (probe.overflow > 1) problems.push('1440 宽横向溢出 ' + probe.overflow + 'px');
          if (!probe.articleLen && route.name === 'read' && probe.emptyState === false) problems.push('阅读区无内容且无空状态');
          /* 路由特征元素 */
          for (const id of ROUTE_CONTRACT[route.name]) {
            if (!probe.contract[id]) problems.push('缺契约元素 #' + id);
          }
          /* 激活 TAB 标记（仅在能识别激活约定时校验） */
          if (probe.activeTab && probe.activeTab.length === 1) {
            const want = 'tab-' + (route.name === 'read' ? 'reader' : route.name);
            if (probe.activeTab[0] !== want) problems.push('激活 TAB 是 ' + probe.activeTab[0] + '，期望 ' + want);
          }
          /* 字体请求失败（@font-face 拉不到会退回系统字体，静默 degrade） */
          const fontFails = (errs.failed || []).filter((f) => /\.(woff2?|ttf)/i.test(f.url || ''));
          if (fontFails.length) {
            problems.push('字体请求失败 ' + fontFails.length + ' 个：' + fontFails.map((f) => String(f.url || '').split('/').pop()).join(', '));
          }
          /* 页面自捕获的运行时错误（index.html 的 __drErrors） */
          if (probe.drErrors && probe.drErrors.length) {
            problems.push('页面捕获到 ' + probe.drErrors.length + ' 个运行时错误：' + probe.drErrors.slice(0, 2).join('；'));
          }
        }
        if (errCount) {
          problems.push('控制台/请求错误 ' + errCount + ' 条：' +
            [].concat(errs.exceptions, errs.console, errs.failed.map((f) => '请求失败 ' + f.url + ' ' + f.error), errs.http.map((h) => 'HTTP ' + h.status + ' ' + h.url)).slice(0, 3).join('；'));
        }
        rr.problems = problems;
        if (problems.length) {
          rr.ok = false;
          baseReport.ok = false;
          for (const p of problems) {
            addDefect({
              severity: /溢出|控制台|请求|hash|#app|缺契约|运行时错误/.test(p) ? 'fail' : 'warn',
              base: base.name, route: route.name, selector: p.replace(/。$/, ''),
              expected: '路由 ' + route.hash + ' 干净可用', actual: p, shot: rr.shotDesktop,
            });
          }
        }
        console.log((problems.length ? '✗' : '✓') + ' ' + base.name + ' ' + route.hash +
          (probe && !probe.error ? '  text=' + (probe.articleLen || probe.appTextLen) + ' DR=' + probe.dr.DR : '') +
          (problems.length ? '  → ' + problems.join('；') : ''));

        /* 窄屏 420×900 */
        col.reset();
        const narrowOk = await setViewport(420, 900);
        await sleep(450);
        let narrow;
        try { narrow = await cdp.evaluate(PROBE_JS); } catch (e) { narrow = { error: e.message }; }
        rr.narrow = narrow;
        rr.shotNarrow = await capture('bc-' + base.name + '-' + route.name + '-420');
        rr.shots.push(rr.shotNarrow);
        const nErr = col.exceptions.length + col.consoleErrors.length;
        if (!narrowOk) {
          /* 视口没切成 420，测不出窄屏 —— 这是工具问题，记 WARN 不误判应用 */
          addDefect({
            severity: 'warn', base: base.name, route: route.name, selector: 'Emulation.setDeviceMetricsOverride',
            expected: '420×900 视口', actual: '视口切换失败，窄屏断言本次未执行', shot: rr.shotNarrow,
          });
          console.log('  ⚠ 420 视口未生效，窄屏断言跳过（工具层）');
        } else if (!narrow || narrow.error) {
          rr.ok = false; baseReport.ok = false;
          addDefect({ severity: 'fail', base: base.name, route: route.name, selector: '420×900', expected: '窄屏可探测', actual: String(narrow && narrow.error), shot: rr.shotNarrow });
        } else {
          if (narrow.innerWidth > 480) {
            addDefect({
              severity: 'warn', base: base.name, route: route.name, selector: 'window.innerWidth',
              expected: '≈420', actual: String(narrow.innerWidth), shot: rr.shotNarrow,
            });
          }
          if (narrow.overflow > 1) {
            rr.ok = false; baseReport.ok = false;
            addDefect({
              severity: 'fail', base: base.name, route: route.name, selector: 'html',
              expected: '420 宽 scrollWidth ≤ innerWidth', actual: 'scrollWidth=' + narrow.scrollWidth + ' innerWidth=' + narrow.innerWidth + '（溢出 ' + narrow.overflow + 'px）',
              shot: rr.shotNarrow,
            });
            console.log('  ✗ 420 宽横向溢出 ' + narrow.overflow + 'px');
          } else {
            console.log('  ✓ 420 宽无横向溢出（' + narrow.innerWidth + 'px）');
          }
          if (nErr) {
            rr.ok = false; baseReport.ok = false;
            addDefect({ severity: 'fail', base: base.name, route: route.name, selector: 'console', expected: '窄屏无控制台错误', actual: col.consoleErrors.slice(0, 2).join('；'), shot: rr.shotNarrow });
          }
        }
        await clearViewport();
      }
    }

    /* 汇总 */
    report.toolFailures = toolFailures;
    if (toolFailures.length) {
      console.log('\n⚠ 工具层失败 ' + toolFailures.length + ' 次（非应用缺陷，但意味着对应断言没跑到）：' +
        toolFailures.map((f) => f.kind + (f.name ? ':' + f.name : '')).join('、'));
    }
    const fails = defects.filter((d) => d.severity === 'fail').length;
    const warns = defects.filter((d) => d.severity === 'warn').length;
    report.summary = {
      bases: report.bases.length,
      routes: report.bases.reduce((n, b) => n + b.routes.length, 0),
      passed: report.bases.reduce((n, b) => n + b.routes.filter((r) => r.ok).length, 0),
      failed: fails,
      warned: warns,
      shots: report.shots.length,
      durationMs: Date.now() - started,
    };
    report.status = fails ? 'fail' : warningsOnly(warns);
    exitCode = fails ? 1 : 0;

    fs.writeFileSync(path.join(PREVIEW, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.log('\n' + (exitCode ? '✗ 有失败项' : '✓ 全部通过') +
      '：' + report.summary.bases + ' 入口 / ' + report.summary.routes + ' 路由 / 失败 ' + fails + ' / 警告 ' + warns +
      ' / 截图 ' + report.shots.length + ' / 用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
    console.log('报告：preview/browser-check.json');
    return exitCode;
  } catch (e) {
    report.status = 'error';
    report.fatal = e.message;
    report.summary = { passed: 0, failed: 1, note: e.message };
    fs.writeFileSync(path.join(PREVIEW, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.error('✗ 致命：' + e.message);
    return 1;
  } finally {
    try { if (serverChild) serverChild.kill(); } catch (e) { /* ignore */ }
    /* Windows 下 kill() 只杀父进程，子进程会残留并占着调试端口 → 杀整棵进程树 */
    if (edge && edge.pid) {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
      } else {
        try { edge.kill(); } catch (e) { /* ignore */ }
      }
    }
    await sleep(600);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}

function warningsOnly(warns) {
  return warns ? 'pass-with-warnings' : 'pass';
}

main().then((code) => process.exit(code === undefined ? 0 : code)).catch((e) => {
  console.error('✗ ' + (e && e.stack || e));
  process.exit(1);
});
