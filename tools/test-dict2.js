#!/usr/bin/env node
/* 深读 DeepRead · 扩展词库（js/data/d2/）验收
 *
 * 验证点：
 *   1. 首屏不加载任何 d2 桶（点词才加载）
 *   2. 核心层（exam + dict.js）查不到的词，resolveAsync 会注入对应首字母桶并查到
 *   3. 桶是「按词首字母」加载的，不牵连同字母之外的文件
 *   4. 查不到的词返回 null，不抛异常
 *   5. 阅读页点生僻词 → 词卡出现中文释义（端到端）
 *
 * 用法：node tools/test-dict2.js
 * 退出码：0 全过 / 1 有失败 / 2 环境阻塞
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
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP ' + msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
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
      expression, returnByValue: true, awaitPromise: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内报错：' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  }
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init || {});
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}
async function waitCDP(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const v = await fetchJSON('http://127.0.0.1:' + port + '/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) { /* 等 */ }
    await sleep(250);
  }
  return null;
}
async function newTarget(port) {
  const url = 'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank');
  try {
    const r = await fetch(url, { method: 'PUT' });
    if (r.ok) return await r.json();
  } catch (e) { /* 老版本 GET */ }
  return fetchJSON(url);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  → ' + String(detail).slice(0, 120) : ''));
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error('找不到 Edge：' + EDGE);
    process.exit(2);
  }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-d2-'));
  let port = 9331;
  for (let i = 0; i < 8; i++) {
    try { await fetchJSON('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(400) }); port++; }
    catch (e) { break; }
  }
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--force-device-scale-factor=1', '--window-size=1280,900', 'about:blank',
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
    await cdp.send('Page.navigate', { url: FILE_BASE });

    // 等应用起来
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(200);
      try { ready = await cdp.evaluate('!!(window.DR && DR.dict && DR.store)'); } catch (e) { ready = false; }
    }
    if (!ready) throw new Error('应用没起来：' + FILE_BASE);

    /* 1. 首屏不该有任何 d2 桶 */
    const bootBuckets = await cdp.evaluate('document.querySelectorAll(\'script[src*="/d2/d2-"]\').length');
    check('首屏不加载任何扩展桶', bootBuckets === 0, 'loaded=' + bootBuckets);

    /* 2. 核心层查不到的词（unalienable 不在考试词库、也不在 dict.js） */
    const syncMiss = await cdp.evaluate('!DR.dict.resolve("unalienable")');
    check('核心层查不到 unalienable', syncMiss === true, 'syncResolve=' + syncMiss);

    /* 3. resolveAsync 走桶 */
    const u = await cdp.evaluate('DR.dict.resolveAsync("unalienable").then(function(r){return r?{w:r.entry.w,zh:r.entry.zh,via:r.via}:null;})');
    check('unalienable 经桶查到', !!u && /不可转让/.test(u.zh || ''), u && u.zh);

    // 考试词库里有词头的（manacles / quicksands）应该同步命中，不该额外拉桶
    const m = await cdp.evaluate('DR.dict.resolveAsync("manacles").then(function(r){return r?r.entry.zh:null;})');
    check('manacles 命中（考试词库/词形还原）', !!m && /手铐/.test(m), m);

    const q = await cdp.evaluate('DR.dict.resolveAsync("quicksands").then(function(r){return r?r.entry.zh:null;})');
    check('quicksands 命中（词形还原）', !!q && /流沙/.test(q), q);

    const a = await cdp.evaluate('DR.dict.resolveAsync("alleghenies").then(function(r){return r?r.entry.zh:null;})');
    check('alleghenies 经桶查到', !!a && /阿利根尼/.test(a), a);

    /* 4. 桶按词首字母加载：unalienable→u，alleghenies→a，其余不该被牵进来 */
    const loaded = await cdp.evaluate('Array.prototype.map.call(document.querySelectorAll(\'script[src*="/d2/d2-"]\'), function(s){return s.src.split("d2-").pop();})');
    const uniq = new Set(loaded);
    check('桶文件按首字母加载（u/a）', uniq.has('u.js') && uniq.has('a.js'), JSON.stringify(loaded));
    check('不牵连同字母之外的桶', uniq.size === 2, JSON.stringify(loaded));
    check('同一桶只注入一次', uniq.size === loaded.length, JSON.stringify(loaded));

    /* 5. 查不到的词：null 且不抛 */
    const none = await cdp.evaluate('DR.dict.resolveAsync("zzzqqxx").then(function(r){return r===null;}).catch(function(){return "throw";})');
    check('不存在的词返回 null', none === true, none);

    /* 6. 端到端：注入文章 → 刷新 → 点生僻词 → 词卡有中文 */
    const text = 'The manacles of segregation and the quicksands of injustice were everywhere.';
    await cdp.evaluate('(function(){DR.store.upsertArticle({id:"qa-d2",title:"QA 生僻词",text:' + JSON.stringify(text) + '});DR.store.setActive("qa-d2");return true;})()');
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(400);
    let ok2 = false;
    for (let i = 0; i < 60 && !ok2; i++) {
      await sleep(200);
      try { ok2 = await cdp.evaluate('!!document.querySelector(\'.w[data-w="manacles"]\')'); } catch (e) { ok2 = false; }
    }
    check('文章已渲染且生僻词可点', ok2, text.slice(0, 30));

    const card = await cdp.evaluate('(function(){var el=document.querySelector(\'.w[data-w="manacles"]\'); if(!el) return "no-el"; el.click(); return "clicked";})()');
    let cardText = '';
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      cardText = await cdp.evaluate('(function(){var c=document.getElementById("word-card"); return c?c.textContent:"";})()');
      if (/手铐/.test(cardText)) break;
    }
    check('点 manacles 后词卡出现「手铐」', /手铐/.test(cardText), (cardText || card).slice(0, 80));

    /* 7. 页内无脚本错误 */
    const errs = await cdp.evaluate('(window.__drErrors||[]).length');
    check('无未捕获脚本错误', errs === 0, 'errors=' + errs);
  } finally {
    try { edge.kill(); } catch (e) { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' 项断言，' + failed.length + ' 失败');
  if (failed.length) {
    failed.forEach((f) => console.log('  FAIL: ' + f.name + '  ' + f.detail));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试环境失败：' + e.message);
  process.exit(2);
});
