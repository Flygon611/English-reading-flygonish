#!/usr/bin/env node
/* 移动端阅读验收：
 *   1. 顶栏在阅读时随滚动收起、顶部细进度条可见且随进度增长
 *   2. 手机端滚动能积累进度（写入 localStorage），刷新后恢复
 *   3. 刷新后不点词也恢复「查过」的灰色标记
 *   4. 电子书：刷新后回到同一章、同一位置
 *
 * 用法：node tools/test-mobile-read.js
 * 依赖本机 Edge；epub 用 Downloads 里的 Animal Farm（存在才跑电子书部分）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html#/read';
const EPUB = 'C:/Users/25676/Downloads/Animal Farm (George Orwell) (z-library.sk, 1lib.sk, z-lib.sk).epub';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  → ' + String(detail).slice(0, 110) : ''));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
  }
  send(method, params, t) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时 ' + method)); }
      }, t || 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expr, t) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, t);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面错误：' + ((d.exception && (d.exception.description || d.exception.value)) || d.text).split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  }
}

async function waitFor(cdp, expr, tries, ms) {
  for (let i = 0; i < (tries || 60); i++) {
    await sleep(ms || 250);
    try { if (await cdp.ev(expr)) return true; } catch (e) { /* 页面还没就绪 */ }
  }
  return false;
}

(async () => {
  if (!fs.existsSync(EDGE)) { console.error('找不到 Edge'); process.exit(2); }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-mobile-'));
  let port = 9451;
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--force-device-scale-factor=1', '--window-size=390,844', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      await sleep(250);
      try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) ver = await r.json(); } catch (e) {}
    }
    if (!ver) throw new Error('Edge 调试端口没起来');
    const t = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 失败')));
      setTimeout(() => rej(new Error('WebSocket 超时')), 15000);
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: URL });
    if (!await waitFor(cdp, '!!(window.DR && DR.reader)', 80, 200)) throw new Error('应用没起来');

    /* ---------- 1. 普通文章 ---------- */
    await cdp.ev('(function(){var b=document.querySelector("#btn-load-sample"); b&&b.click(); return true;})()');
    await sleep(700);
    const headH = await cdp.ev('Math.round(document.querySelector("#article-head").getBoundingClientRect().height)');
    check('手机端文章头收紧（< 220px）', headH > 0 && headH < 220, headH + 'px');

    // 点一个词入库（后面验证刷新后标记恢复）
    await cdp.ev('(function(){var w=document.querySelector("#article-body .w"); w&&w.click(); return true;})()');
    await sleep(900);
    const noted0 = await cdp.ev('document.querySelectorAll("#article-body .w--noted").length');
    check('点词后出现灰色标记', noted0 > 0, noted0 + ' 个');

    // 向下滚：顶栏收起 + 进度条出现
    await cdp.ev('(function(){var sc=document.querySelector("#article-scroll"); sc.scrollTop=320; sc.dispatchEvent(new Event("scroll")); return sc.scrollTop;})()');
    await sleep(1200);
    const down = await cdp.ev('(function(){var bar=document.querySelector("#read-progressbar");return {collapsed:document.body.classList.contains("bar-collapsed"), barOn:bar&&bar.classList.contains("is-on"), width:bar&&bar.firstElementChild?bar.firstElementChild.style.width:"", num:(document.querySelector("#read-progress")||{}).textContent, top:document.querySelector("#article-scroll").scrollTop};})()');
    check('向下滚动后顶栏收起', down.collapsed === true, JSON.stringify(down));
    check('顶部细进度条可见且有进度', down.barOn === true && parseFloat(down.width) > 0, down.width);
    check('阅读进度在累积（百分比 > 0）', parseInt(down.num, 10) > 0, down.num);

    // 向上滚：顶栏恢复
    await cdp.ev('(function(){var sc=document.querySelector("#article-scroll"); sc.scrollTop=0; sc.dispatchEvent(new Event("scroll")); return true;})()');
    await sleep(700);
    const up = await cdp.ev('document.body.classList.contains("bar-collapsed")');
    check('回到顶部后顶栏恢复', up === false, 'collapsed=' + up);

    /* ---------- 2. 刷新：不点词也应恢复标记 + 进度 ---------- */
    await cdp.ev('(function(){var sc=document.querySelector("#article-scroll"); sc.scrollTop=320; sc.dispatchEvent(new Event("scroll")); return true;})()');
    await sleep(1400);
    const saved = await cdp.ev('(function(){var a=DR.store.getArticle(DR.store.activeId());return a&&a.progress;})()');
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(800);
    await waitFor(cdp, '!!(window.DR && DR.reader)', 80, 200);
    // 等词库懒加载完成（恢复灰色标记靠它）
    await waitFor(cdp, 'DR.dict && DR.dict.hasFull()', 80, 250);
    await sleep(600);
    const afterReload = await cdp.ev('(function(){var a=DR.store.getArticle(DR.store.activeId());var bar=document.querySelector("#read-progressbar");return {noted:document.querySelectorAll("#article-body .w--noted").length, progress:a&&a.progress, scrollTop:document.querySelector("#article-scroll").scrollTop, barOn:bar&&bar.classList.contains("is-on")};})()');
    check('刷新后不点词也显示灰色标记', afterReload.noted > 0, afterReload.noted + ' 个');
    check('刷新后从原位置继续读', afterReload.scrollTop > 100, 'scrollTop=' + afterReload.scrollTop);
    check('刷新后进度条仍在', afterReload.barOn === true, String(afterReload.barOn));

    /* ---------- 3. 电子书：刷新回到同一章 ---------- */
    if (fs.existsSync(EPUB)) {
      await cdp.ev('DR.reader.openPaste(), true');
      await sleep(300);
      const fileInput = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#paste-file")' });
      const objId = fileInput.result && fileInput.result.objectId;
      await cdp.send('DOM.setFileInputFiles', { files: [EPUB], objectId: objId });
      if (!await waitFor(cdp, '!document.querySelector("#book-preview").hidden', 80, 250)) throw new Error('epub 预览没出来');
      await cdp.ev('document.querySelector("#btn-paste-start").click(), true');
      if (!await waitFor(cdp, '!!document.querySelector("#chapter-nav")', 80, 250)) throw new Error('电子书没打开');
      await sleep(700);

      // 跳到第 3 章并滚动
      await cdp.ev('(function(){var s=document.querySelector("#chapter-select"); s.value="2"; s.dispatchEvent(new Event("change")); return true;})()');
      await sleep(800);
      await cdp.ev('(function(){var sc=document.querySelector("#article-scroll"); sc.scrollTop=900; sc.dispatchEvent(new Event("scroll")); return sc.scrollTop;})()');
      await sleep(1400);
      const bookBefore = await cdp.ev('(function(){var a=DR.store.getArticle(DR.store.activeId());return {ci:a.chapterIndex, p:a.progress};})()');

      await cdp.send('Page.reload', { ignoreCache: false });
      await sleep(900);
      await waitFor(cdp, '!!(document.querySelector("#chapter-select"))', 100, 250);
      await sleep(700);
      const bookAfter = await cdp.ev('(function(){var a=DR.store.getArticle(DR.store.activeId());return {ci:a.chapterIndex, p:a.progress, sel:document.querySelector("#chapter-select").selectedIndex, top:document.querySelector("#article-scroll").scrollTop};})()');
      check('电子书刷新后回到同一章', bookAfter.ci === 2 && bookAfter.sel === 2, JSON.stringify(bookAfter));
      check('电子书刷新后回到章内位置', bookAfter.top > 100, 'scrollTop=' + bookAfter.top);
      check('电子书整本进度已落盘', typeof bookAfter.p === 'number' && bookAfter.p > 0, String(bookAfter.p));
    } else {
      console.log('  （跳过电子书部分：没找到 Animal Farm.epub）');
    }
  } finally {
    try { edge.kill(); } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' 项断言，' + failed.length + ' 失败');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试环境失败：' + e.message); process.exit(2); });
