#!/usr/bin/env node
/* 深读 DeepRead · 电子书导入验收（真浏览器）
 *
 * 用法：node tools/test-import.js [epub 或 txt 路径]
 *      默认用 Downloads 里的 Animal Farm 与哈利波特合订本（存在才跑）。
 * 覆盖：file:// 下选文件 → 解析 → 预览章节 → 导入 → IndexedDB 落盘 → 阅读页分章切换。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE_BASE = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html#/read';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP ' + msg.error.message)); else resolve(msg.result);
      }
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
  async evaluate(expression, timeoutMs, byValue) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: byValue !== false, awaitPromise: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内报错：' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).split('\n')[0]);
    }
    return byValue === false ? (r.result && r.result.objectId) : (r.result ? r.result.value : undefined);
  }
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init || {});
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}
async function waitCDP(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fetchJSON('http://127.0.0.1:' + port + '/json/version'); if (v && v.webSocketDebuggerUrl) return v; } catch (e) {}
    await sleep(250);
  }
  return null;
}
async function newTarget(port) {
  const url = 'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank');
  try { const r = await fetch(url, { method: 'PUT' }); if (r.ok) return await r.json(); } catch (e) {}
  return fetchJSON(url);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  → ' + String(detail).slice(0, 110) : ''));
}

const DL = 'C:/Users/25676/Downloads';
const CANDIDATES = [
  path.join(DL, 'Animal Farm (George Orwell) (z-library.sk, 1lib.sk, z-lib.sk).epub'),
  path.join(DL, 'Harry Potter (J.K. Rowling) (z-library.sk, 1lib.sk, z-lib.sk).epub'),
];

async function importOne(cdp, filePath, expect) {
  console.log('\n[导入] ' + path.basename(filePath));
  const t0 = Date.now();
  await cdp.evaluate('DR.reader.openPaste(), true');
  await sleep(250);
  const objId = await cdp.evaluate('document.querySelector("#paste-file")', 20000, false);
  await cdp.send('DOM.setFileInputFiles', { files: [filePath], objectId: objId });

  let shown = false;
  for (let i = 0; i < 120 && !shown; i++) {
    await sleep(250);
    shown = await cdp.evaluate('!document.querySelector("#book-preview").hidden');
  }
  check('解析后出现章节预览', shown, (Date.now() - t0) + 'ms');
  if (!shown) return;

  const meta = await cdp.evaluate('document.querySelector("#book-preview-meta").textContent');
  const title = await cdp.evaluate('document.querySelector("#paste-title").value');
  const author = await cdp.evaluate('document.querySelector("#paste-author").value');
  const rows = await cdp.evaluate('document.querySelectorAll("#book-chapters li").length');
  check('书名来自元数据', !!title && (expect.title ? title.indexOf(expect.title) >= 0 : true), title);
  check('作者来自元数据', !!author && (expect.author ? author.indexOf(expect.author) >= 0 : true), author);
  check('章节列表已渲染', rows >= Math.min(3, expect.chapters), meta + ' / ' + rows + ' 行');

  await cdp.evaluate('document.querySelector("#btn-paste-start").click(), true');
  let opened = false;
  const t1 = Date.now();
  for (let i = 0; i < 160 && !opened; i++) {
    await sleep(250);
    opened = await cdp.evaluate('!!document.querySelector("#chapter-nav")');
  }
  check('导入后进入阅读页并出现章节目录', opened, (Date.now() - t1) + 'ms');
  if (!opened) return;

  const info = await cdp.evaluate('(function(){var s=document.querySelector("#chapter-select");return {opts:s?s.options.length:0, cur:s?s.selectedIndex:-1, sel:s?s.value:""};})()');
  check('目录条目数 = 章节数', info.opts === expect.chapters, info.opts + ' / 期望 ' + expect.chapters);

  const before = await cdp.evaluate('document.querySelector("#article-body").textContent.slice(0,60)');
  await cdp.evaluate('(function(){var s=document.querySelector("#chapter-select"); s.value=String(Number(s.value)+1); s.dispatchEvent(new Event("change")); return true;})()');
  await sleep(400);
  const after = await cdp.evaluate('document.querySelector("#article-body").textContent.slice(0,60)');
  check('切到下一章后正文变化', before !== after, JSON.stringify(after.slice(0, 40)));
  const idx = await cdp.evaluate('(function(){var a=DR.store.getArticle(DR.store.activeId());return a?a.chapterIndex:-1;})()');
  check('章节进度写回文章元数据', idx === 1, 'chapterIndex=' + idx);
  const words = await cdp.evaluate('DR.text.stats(document.querySelector("#article-body").textContent).wordCount');
  check('当前章词数合理', words > 10, words + ' 词');
}

(async () => {
  if (!fs.existsSync(EDGE)) { console.error('找不到 Edge：' + EDGE); process.exit(2); }
  const extra = process.argv.slice(2);
  const files = (extra.length ? extra : CANDIDATES).filter((f) => fs.existsSync(f));
  if (!files.length) { console.error('没有可用的 epub 测试文件'); process.exit(2); }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-imp-'));
  let port = 9351;
  for (let i = 0; i < 8; i++) {
    try { await fetchJSON('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(400) }); port++; }
    catch (e) { break; }
  }
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--force-device-scale-factor=1', '--window-size=1440,960', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    const ver = await waitCDP(port, 20000);
    if (!ver) throw new Error('Edge 调试端口没起来');
    const target = await newTarget(port);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
      setTimeout(() => rej(new Error('WebSocket 超时')), 15000);
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Page.navigate', { url: FILE_BASE });

    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(200);
      try { ready = await cdp.evaluate('!!(window.DR && DR.reader && DR.ebook && DR.books)'); } catch (e) { ready = false; }
    }
    if (!ready) throw new Error('应用没起来');

    const expectations = {
      'Animal Farm': { title: 'Animal Farm', author: 'George Orwell', chapters: 10 },
      'Harry Potter': { title: 'Harry Potter', author: 'J.K. Rowling', chapters: 200 },
    };
    for (const f of files) {
      const base = path.basename(f);
      let expect = null;
      const key = Object.keys(expectations).find((k) => base.indexOf(k) >= 0);
      if (key) expect = expectations[key];
      else if (/\.txt$/i.test(base)) {
        expect = { title: base.replace(/\.txt$/i, '').split(' (')[0], author: 'Ada Lovelace', chapters: 3 };
      }
      if (!expect) continue;
      await importOne(cdp, f, expect);
    }

    /* 重新打开页面，确认章节真的落在了 IndexedDB 里 */
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(600);
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      try { if (await cdp.evaluate('!!(window.DR && DR.store)')) break; } catch (e) {}
    }
    const books = await cdp.evaluate('DR.store.articles().filter(function(a){return a.kind==="book";}).map(function(a){return {id:a.id,t:a.title,n:a.chapterCount};})');
    check('刷新后书目仍在（元数据在 localStorage）', books.length >= 1, JSON.stringify(books).slice(0, 120));
    if (books.length) {
      const cnt = await cdp.evaluate('DR.books.get(' + JSON.stringify(books[0].id) + ').then(function(c){return c?c.length:0;})');
      check('刷新后章节正文仍能读出（IndexedDB）', cnt === books[0].n, cnt + ' / ' + books[0].n);
    }
  } finally {
    try { edge.kill(); } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' 项断言，' + failed.length + ' 失败');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试环境失败：' + e.message); process.exit(2); });
