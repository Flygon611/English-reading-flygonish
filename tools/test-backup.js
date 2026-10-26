#!/usr/bin/env node
/* 深读 DeepRead · 备份导出/导入验收（真浏览器）
 *
 * 流程：导入一本 epub → 读到第 3 章 → 打包（整本书 + 进度）→ 清空本地 →
 *       用备份恢复 → 校验书目、正文、章节位置、生词都在。
 *
 * 用法：node tools/test-backup.js [epub 路径]
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
      }, timeoutMs || 60000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expression, byValue) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: byValue !== false, awaitPromise: true });
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

const DEFAULT_EPUB = 'C:/Users/25676/Downloads/Animal Farm (George Orwell) (z-library.sk, 1lib.sk, z-lib.sk).epub';

(async () => {
  if (!fs.existsSync(EDGE)) { console.error('找不到 Edge'); process.exit(2); }
  const epub = process.argv[2] || DEFAULT_EPUB;
  if (!fs.existsSync(epub)) { console.error('找不到 epub：' + epub); process.exit(2); }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-bak-'));
  let port = 9371;
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
    for (let i = 0; i < 80 && !ready; i++) {
      await sleep(200);
      try { ready = await cdp.ev('!!(window.DR && DR.backup && DR.books && DR.reader)'); } catch (e) {}
    }
    if (!ready) throw new Error('应用没起来');

    /* 1. 导入一本 epub */
    await cdp.ev('DR.reader.openPaste(), true');
    await sleep(250);
    const objId = await cdp.ev('document.querySelector("#paste-file")', false);
    await cdp.send('DOM.setFileInputFiles', { files: [epub], objectId: objId });
    for (let i = 0; i < 120; i++) { await sleep(250); if (await cdp.ev('!document.querySelector("#book-preview").hidden')) break; }
    await cdp.ev('document.querySelector("#btn-paste-start").click(), true');
    for (let i = 0; i < 120; i++) { await sleep(250); if (await cdp.ev('!!document.querySelector("#chapter-nav")')) break; }
    check('epub 已导入并进入阅读页', await cdp.ev('!!document.querySelector("#chapter-nav")'));

    /* 2. 读到第 3 章（进度位置要能被备份记住） */
    await cdp.ev('(function(){var s=document.querySelector("#chapter-select");s.value="2";s.dispatchEvent(new Event("change"));return true;})()');
    await sleep(500);
    await cdp.ev('(function(){var el=document.querySelector("#article-scroll");el.scrollTop=800;el.dispatchEvent(new Event("scroll"));return el.scrollTop;})()');
    await sleep(900);
    const before = await cdp.ev('(function(){var a=DR.store.getArticle(DR.store.activeId());return {id:a.id,t:a.title,ci:a.chapterIndex,p:a.progress,n:a.chapterCount};})()');
    check('导入后章节位置已记录', before && before.ci === 2, JSON.stringify(before));

    /* 3. 打包 */
    const pack = await cdp.ev('DR.backup.build().then(function(b){var j=DR.backup.toJSON(b);window.__bak=j;return {v:b.v,articles:b.articles.length,books:Object.keys(b.books).length,chapters:DR.backup.statsOf(b).chapters,bytes:j.length};})');
    check('备份是 v2 且含书籍正文', pack && pack.v === 2 && pack.books === 1 && pack.chapters === before.n, JSON.stringify(pack));
    check('备份体积合理（>100 KB）', pack && pack.bytes > 100000, (pack.bytes / 1024).toFixed(0) + ' KB');

    /* 4. 清空本地（文章 + 生词 + 书籍记录），模拟新设备 */
    await cdp.ev('(function(){var ids=DR.store.articles().map(function(a){return a.id;});DR.store.saveArticles([]);DR.store.setActive("");return Promise.all(ids.map(function(id){return DR.books.del(id);})).then(function(){return true;});})()');
    await sleep(400);
    const wiped = await cdp.ev('(function(){return {articles:DR.store.articles().length};})()');
    check('本地已清空', wiped.articles === 0, JSON.stringify(wiped));

    /* 5. 导入备份 */
    const imp = await cdp.ev('DR.backup.importBundle(JSON.parse(window.__bak)).then(function(r){return r;})');
    check('导入返回统计', imp && imp.articles === 1, JSON.stringify(imp));
    await sleep(400);

    const after = await cdp.ev('(function(){var a=DR.store.articles()[0];return a?{id:a.id,t:a.title,ci:a.chapterIndex,p:a.progress,n:a.chapterCount,kind:a.kind}:null;})()');
    check('书目恢复（书名/章数/类型）', after && after.t === before.t && after.n === before.n && after.kind === 'book', JSON.stringify(after));
    check('章节位置恢复（第 3 章）', after && after.ci === 2, 'chapterIndex=' + (after && after.ci));

    const cnt = await cdp.ev('DR.books.get(' + JSON.stringify(before.id) + ').then(function(c){return c?c.length:0;})');
    check('正文恢复（章节数一致）', cnt === before.n, cnt + ' / ' + before.n);

    const firstWords = await cdp.ev('DR.books.get(' + JSON.stringify(before.id) + ').then(function(c){return c[0].text.slice(0,40);})');
    check('正文内容非空', !!firstWords && firstWords.length > 20, JSON.stringify(firstWords));

    /* 6. 重新打开这本书，确认落回第 3 章 */
    await cdp.ev('DR.reader.openArticle(' + JSON.stringify(before.id) + '), true');
    for (let i = 0; i < 80; i++) { await sleep(250); if (await cdp.ev('!!document.querySelector("#chapter-select")')) break; }
    const sel = await cdp.ev('document.querySelector("#chapter-select").selectedIndex');
    check('打开书直接落回上次章节', sel === 2, 'selectedIndex=' + sel);
  } finally {
    try { edge.kill(); } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' 项断言，' + failed.length + ' 失败');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试环境失败：' + e.message); process.exit(2); });
