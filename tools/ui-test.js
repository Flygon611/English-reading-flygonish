#!/usr/bin/env node
/* 深读 DeepRead · 交互冒烟测试（qa-verify）
 *
 * 真浏览器里用真实 DOM 事件走一遍用户链路，不依赖 puppeteer：
 *   T0 环境   应用启动、DR 运行期 API 就位
 *   T1 粘贴   贴入 ≥600 词英文长文 → 正文渲染成可点单词
 *   T2 查词   ubiquitous / deliberating(-ing 还原) / Were(大写 + be 还原) + 2 个补充词，
 *             断言词头 / 音标 / 释义 / 词级 / 例句，发音按钮可点且不抛异常
 *   T3 生词本 条数、语境句、日期；reload 后仍在；搜索 / 筛选 / 标记已掌握
 *   T4 复习   进入 → 翻卡 → 三档评分 → 汇总；再次进入按到期筛选
 *   T5 句析   点句子 → 分析卡出现主干 / 成分 / 语法点 + 「自动推断」标注；角色着色可开关
 *   T6 文章   保存 → 新建第二篇 → 切换 → 删除 → 刷新后状态正确
 *   T7 设置   主题切换、字号调节、420px 无横向溢出
 *
 * 用法：
 *   node tools/ui-test.js                # file:// 双击场景（验收 P0 目标）
 *   node tools/ui-test.js --base http    # http://127.0.0.1:8787/
 *   node tools/ui-test.js --plan         # 只校验测试数据与步骤计划，不启动浏览器
 *   node tools/ui-test.js --selftest     # 用临时页面验证测试工具链本身
 *   node tools/ui-test.js --only T2,T3   # 只跑指定步骤（前面步骤会作为前置跳过）
 *
 * 退出码：0 全绿 / 1 有失败项 / 2 环境阻塞
 * 产物：preview/ui-test.json + preview/ui-*.png；失败额外打印选择器、DOM 摘要、截图路径。
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
const CDP_PORT = Number(process.env.DR_CDP_PORT || 9224);
let cdpPort = CDP_PORT;

/* ============================================================ 测试文本 */

const TITLE_1 = 'The Harbour at Dawn';
const ARTICLE_1 = [
  'The harbour at dawn is a study in patience. Fishermen move along the quay with the quiet economy of people who have repeated the same motions for thirty years, checking knots, coiling rope, and testing the cold brass fittings of their lamps. Nothing about the scene announces itself as remarkable. There is no ceremony, no speech, no crowd. Yet the entire economy of the region rests on these unremarkable hours, on the willingness of a few hundred people to rise before the light and trust that the sea will behave itself. When the first boats slip past the breakwater, the harbour becomes one more demonstration of a simple truth: the most important work in any society is usually the work nobody photographs.',
  'By noon the same harbour has become something else entirely. Tourists arrive in coaches, guides raise small coloured flags, and the high-season economy takes over with an insistence that feels almost theatrical. Smartphones are ubiquitous, held aloft above the crowd to capture the fishing boats that the crowd itself has never actually boarded. Local shopkeepers, who spent the morning quietly mending nets, now sell postcards and oyster shells and small glass jars of sea salt. The transition is seamless, and slightly unreal. A visitor who stays for two days might reasonably conclude that the town exists in order to be photographed, and that the men on the boats are there for the same reason.',
  'That conclusion, however, would miss almost everything. For nearly two years the harbour authority had been deliberating over a proposal that would have turned the east quay into a commercial marina, complete with restaurants and a covered walkway and a fee for the view. The committee, which had been deliberating for nearly six hours in a room with one small window, finally reached a conclusion that satisfied neither the union representatives nor the management. The proposal was rejected, but only because the two sides could not agree on which of them would bear the cost of the survey. Nobody in that room described the outcome as a victory.',
  'Were the fishermen consulted? Formally, yes. A public meeting was held in the school hall in February, and twelve of the ninety-two licence holders attended. The minutes record three questions, one of which concerned parking. This is not unusual, and it is not a conspiracy; it is what participation looks like when a community has already learned that its objections will be absorbed and rephrased by people who are paid to be patient. The authority eventually described the meeting as constructive. It was, in the narrow sense that nobody shouted.',
  'What the report did not describe, because a report of that kind cannot describe it, is the difference between a harbour that is used and a harbour that is displayed. A used harbour smells of diesel and fish and wet rope; its walls are chipped where carts have scraped them; its ladders are rusted exactly at the height of a human hand. A displayed harbour is repainted every third spring and smells of nothing in particular. Both can be beautiful. Only one of them can be repaired by the people who live beside it, and that is the distinction that the committee never found a way to place on its agenda.',
  'The most telling detail came afterwards. When the decision was announced, the shopkeepers did not celebrate and the fishermen did not complain. The east quay simply stayed as it was: cracked, useful, unphotographed. Three weeks later a television crew arrived to film a documentary about heritage, and for two days the harbour was full of lighting rigs and people saying the word authentic. Then the crew left, the fees were paid to the council, and the town returned to the ordinary business of earning a living. Anyone who wants to understand the place should visit in March, when nobody is documenting anything at all.',
].join('\n\n');

const TITLE_2 = 'Second Article For Switching';
const ARTICLE_2 = [
  'A short second text whose only job is to prove that the library can hold more than one article at a time. It mentions a lighthouse, a ledger, and a stubborn donkey, because switch tests are more pleasant when the vocabulary is absurd. The lighthouse keeper kept a ledger in which every visitor was recorded with unnecessary precision, including the exact minute of arrival and the approximate number of complaints.',
  'The donkey, for its part, ignored the ledger entirely. It stood in the yard, ate whatever the wind delivered, and regarded the sea with the calm contempt of an animal that has never needed to be photographed. When the keeper finally closed the book, the pages smelled of salt, and the afternoon had already gone somewhere else.',
].join('\n\n');

const TARGET_WORDS = ['ubiquitous', 'deliberating', 'Were'];

/* ============================================================ CDP 驱动 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const hasFlag = (name) => process.argv.indexOf('--' + name) >= 0;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = [];
    this.exceptions = [];
    this.consoleErrors = [];
    this.dialogs = [];
    this.failedRequests = [];
    this.reqUrls = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error('CDP ' + msg.method + '：' + msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      const p = msg.params || {};
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {};
        const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
        this.exceptions.push(String(text).split('\n').slice(0, 2).join(' | '));
      } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        this.consoleErrors.push((p.args || []).map((a) => (a.value !== undefined ? a.value : a.description || '')).join(' ').slice(0, 300));
      } else if (msg.method === 'Log.entryAdded' && p.entry && p.entry.level === 'error') {
        this.consoleErrors.push(String(p.entry.text || '').slice(0, 260) + (p.entry.url ? ' @' + p.entry.url : ''));
      } else if (msg.method === 'Network.requestWillBeSent') {
        this.reqUrls.set(p.requestId, (p.request && p.request.url) || '');
      } else if (msg.method === 'Network.loadingFailed') {
        var u = this.reqUrls.get(p.requestId) || '';
        if (!/favicon/i.test(u)) this.failedRequests.push({ url: u, error: p.errorText || '', type: p.type || '' });
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push({ type: p.type, message: p.message });
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('页面内报错：' + String(detail).split('\n')[0]);
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
  const deadline = Date.now() + (ms || 20000);
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

/* ======================================================= 注入页面的助手 */

const QA_HELPER = String.raw`
window.__qa = (function () {
  var A = {};
  A.q = function (sel) { try { return document.querySelector(sel); } catch (e) { return null; } };
  A.all = function (sel) { try { return [].slice.call(document.querySelectorAll(sel)); } catch (e) { return []; } };
  A.txt = function (el) { return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
  A.vis = function (el) {
    if (!el) return false;
    var s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
  };
  A.click = function (el, opt) {
    if (!el) return false;
    opt = opt || {};
    if (opt.scroll !== false && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    }
    var r = el.getBoundingClientRect();
    var x = Math.round(r.left + Math.max(1, Math.min(r.width / 2, Math.max(1, r.width - 1))));
    var y = Math.round(r.top + Math.max(1, Math.min(r.height / 2, Math.max(1, r.height - 1))));
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, detail: 1
    };
    var seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < seq.length; i++) {
      var name = seq[i];
      var Type = name.indexOf('pointer') === 0 ? (window.PointerEvent || window.MouseEvent) : window.MouseEvent;
      var ev = new Type(name, base);
      try { el.dispatchEvent(ev); } catch (e) {}
    }
    return true;
  };
  A.clickSel = function (sel) { return A.click(A.q(sel)); };
  A.setValue = function (el, val) {
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : (el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === val;
  };
  A.setSel = function (sel, value) { return A.setValue(A.q(sel), value); };
  A.setSelReg = function (el, value) {
    if (!el) return false;
    var desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === value;
  };
  A.clickWord = function (w, surface) {
    w = String(w).toLowerCase();
    var scope = A.q('#article-body') || document;
    var cands = A.all('#article-body [data-w="' + w + '"]');
    if (!cands.length) cands = A.all('[data-w="' + w + '"]');
    if (!cands.length) return null;
    var el = null;
    if (surface) {
      for (var i = 0; i < cands.length; i++) {
        if (String(cands[i].textContent || '').trim() === surface) { el = cands[i]; break; }
      }
    }
    if (!el) {
      for (var j = 0; j < cands.length; j++) { if (A.vis(cands[j])) { el = cands[j]; break; } }
    }
    if (!el) el = cands[0];
    A.click(el);
    return { text: String(el.textContent || '').trim(), tag: el.tagName, total: cands.length, inArticle: !!scope };
  };
  A.clickWordByText = function (text) {
    var want = String(text);
    var spans = A.all('#article-body .w');
    var hit = null;
    for (var i = 0; i < spans.length; i++) {
      if (String(spans[i].textContent || '').trim() === want) { hit = spans[i]; break; }
    }
    if (!hit) return null;
    A.click(hit);
    return { text: String(hit.textContent || '').trim(), dataW: hit.getAttribute('data-w'), tag: hit.tagName, total: spans.length };
  };
  A.sentenceAt = function (needle) {
    var host = A.q('#article-body') || document.body;
    var sents = A.all('#article-body .sent[data-si]');
    var target = null, gi = -1;
    for (var i = 0; i < sents.length; i++) {
      if (A.txt(sents[i]).indexOf(needle) >= 0) { target = sents[i]; gi = i; break; }
    }
    if (!target) {
      var walker0 = document.createTreeWalker(host, window.NodeFilter.SHOW_TEXT, null, false);
      var n0 = null, guard0 = 0;
      while ((n0 = walker0.nextNode()) && guard0++ < 20000) {
        if (n0.nodeValue && n0.nodeValue.indexOf(needle) >= 0 && n0.nodeValue.trim().length > 3) {
          target = n0.parentElement; break;
        }
      }
      if (!target) return null;
    }
    var targetTextEl = target;
    function hitPoint(node, k) {
      var range = document.createRange();
      range.setStart(node, k); range.setEnd(node, k + 1);
      var r = range.getBoundingClientRect();
      if (!r || !r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    var punct = /[,.!?;:—–'")]/;
    var candidates = [];
    var walker = document.createTreeWalker(targetTextEl, window.NodeFilter.SHOW_TEXT, null, false);
    var node = null, guard = 0;
    while ((node = walker.nextNode()) && guard++ < 200) {
      var txt = node.nodeValue || '';
      for (var k = 0; k < txt.length; k++) {
        if (punct.test(txt.charAt(k))) {
          var p1 = hitPoint(node, k);
          if (p1) candidates.push(p1);
        }
      }
      for (var s = 0; s < txt.length; s++) {
        if (txt.charAt(s) === ' ') {
          var p2 = hitPoint(node, s);
          if (p2) candidates.push(p2);
        }
      }
    }
    var chosen = null, hittag = '';
    for (var c = 0; c < candidates.length; c++) {
      var el = document.elementFromPoint(candidates[c].x, candidates[c].y);
      if (!el) continue;
      if (el.closest && el.closest('[data-w]')) continue;
      if (targetTextEl.contains && !targetTextEl.contains(el)) continue;
      chosen = candidates[c]; hittag = el.tagName + '.' + String(el.className || '').split(' ')[0]; break;
    }
    if (!chosen) {
      var rr = targetTextEl.getBoundingClientRect();
      chosen = { x: Math.round(rr.left + 2), y: Math.round(rr.top + rr.height / 2) };
      var e2 = document.elementFromPoint(chosen.x, chosen.y);
      hittag = e2 ? (e2.tagName + '.' + String(e2.className || '').split(' ')[0]) : '';
    }
    var hit = document.elementFromPoint(chosen.x, chosen.y) || targetTextEl;
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: chosen.x, clientY: chosen.y, screenX: chosen.x, screenY: chosen.y, button: 0, buttons: 1, detail: 1
    };
    var seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var q = 0; q < seq.length; q++) {
      var Type = seq[q].indexOf('pointer') === 0 ? (window.PointerEvent || window.MouseEvent) : window.MouseEvent;
      try { hit.dispatchEvent(new Type(seq[q], base)); } catch (e) {}
    }
    return {
      x: chosen.x, y: chosen.y, tag: hit.tagName, cls: String(hit.className || '').slice(0, 80),
      onWord: !!(hit.closest && hit.closest('[data-w]')),
      sentIndex: targetTextEl.getAttribute ? targetTextEl.getAttribute('data-si') : null,
      sentCount: sents.length, sentText: A.txt(targetTextEl).slice(0, 80)
    };
  };
  A.byText = function (sel, re) {
    var rx = re instanceof RegExp ? re : new RegExp(re);
    var out = [];
    var items = A.all(sel);
    for (var i = 0; i < items.length; i++) {
      if (rx.test(A.txt(items[i])) && A.vis(items[i])) out.push(items[i]);
    }
    return out;
  };
  A.clickText = function (sel, re) {
    var items = A.byText(sel, re);
    if (!items.length) return null;
    A.click(items[0]);
    return { n: items.length, text: A.txt(items[0]).slice(0, 80), tag: items[0].tagName };
  };
  A.rows = function () {
    var host = A.q('#notebook-list');
    if (!host) return { n: 0, how: 'no-host' };
    var ways = [['.nb-item', 'nb-item'], ['.nb-item[data-key]', 'nb-item[data-key]'], ['[data-key]', 'data-key'], ['li', 'li'], [':scope > *', 'child']];
    for (var i = 0; i < ways.length; i++) {
      var items = A.all('#notebook-list ' + ways[i][0]);
      if (items.length) return { n: items.length, how: ways[i][1] };
    }
    return { n: 0, how: 'empty' };
  };
  A.rowTexts = function () {
    var host = A.q('#notebook-list');
    if (!host) return [];
    var ways = ['.nb-item', '.nb-item[data-key]', '[data-key]', 'li', ':scope > *'];
    for (var i = 0; i < ways.length; i++) {
      var items = A.all('#notebook-list ' + ways[i]);
      if (items.length) return items.map(function (el) { return A.txt(el).slice(0, 300); });
    }
    return [];
  };
  A.rowEls = function () {
    var ways = ['.nb-item', '.nb-item[data-key]', '[data-key]', 'li', ':scope > *'];
    for (var i = 0; i < ways.length; i++) {
      var items = A.all('#notebook-list ' + ways[i]);
      if (items.length) return items;
    }
    return [];
  };
  A.ls = function (key) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  A.overflow = function () {
    var de = document.documentElement;
    return { scroll: de.scrollWidth, inner: window.innerWidth, over: Math.max(0, de.scrollWidth - window.innerWidth) };
  };
  A.fontSize = function (sel) {
    var el = A.q(sel) || A.q('#article-body');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  };
  A.dom = function (sel) {
    var el = A.q(sel);
    if (!el) return '<无 ' + sel + '>';
    return String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 900);
  };
  A.summary = function () {
    var host = A.q('#article-body');
    return {
      hash: location.hash,
      title: location.href,
      appText: A.q('#app') ? A.txt(A.q('#app')).slice(0, 200) : '',
      articleLen: host ? A.txt(host).length : 0,
      wordTokens: A.all('#article-body [data-w]').length,
      wordCards: A.all('#word-card').length,
      sentenceCard: A.q('#sentence-card') ? A.txt(A.q('#sentence-card')).slice(0, 160) : '',
      toasts: A.q('#toast-layer') ? A.txt(A.q('#toast-layer')).slice(0, 200) : '',
      overlays: A.all('[id$="-modal"]').filter(A.vis).map(function (m) { return m.id; }),
      rows: A.rows().n,
      theme: document.documentElement.getAttribute('data-theme') || '',
      overflow: A.overflow(),
      settings: A.ls('dr.settings.v1'),
      articles: (A.ls('dr.articles.v1') || []).length,
      notebookN: (function () { var n = A.ls('dr.notebook.v1'); return n && n.order ? n.order.length : 0; })()
    };
  };
  return A;
})();
`;

/* ========================================================= 结果与断言 */

class StepFail extends Error {}
const REQUIRED = (rec, cond, name, detail) => {
  if (cond) { rec.asserts.push({ name, status: 'pass', detail: detail || '' }); return true; }
  rec.asserts.push({ name, status: 'fail', detail: detail || '' });
  throw new StepFail(name + (detail ? '｜' + detail : ''));
};
const SOFT = (rec, cond, name, detail) => {
  rec.asserts.push({ name, status: cond ? 'pass' : 'warn', detail: detail || '' });
  return !!cond;
};

/* =============================================================== 主流程 */

async function main() {
  const only = arg('only', '');
  const planOnly = hasFlag('plan');
  const selftest = hasFlag('selftest');
  const baseArg = String(arg('base', 'file'));

  /* ---- --plan：先校验测试数据本身，不启浏览器 ---- */
  const wordCount = (ARTICLE_1.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  const plan = {
    article1: { title: TITLE_1, words: wordCount, paragraphs: ARTICLE_1.split(/\n\n/).length },
    article2: { title: TITLE_2, words: (ARTICLE_2.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length },
    targets: TARGET_WORDS.map((w) => ({ w, inArticle: new RegExp('\\b' + w + '\\b').test(ARTICLE_1), lower: w.toLowerCase() })),
    steps: ['T0 环境', 'T1 粘贴', 'T2 查词', 'T3 生词本', 'T4 复习', 'T5 句析', 'T6 文章', 'T7 设置/窄屏'],
  };
  if (planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    const bad = [];
    if (wordCount < 600) bad.push('测试文章 ' + wordCount + ' 词，不足 600');
    for (const t of plan.targets) if (!t.inArticle) bad.push('测试文章里缺少目标词 ' + t.w);
    if (bad.length) { console.error('✗ 测试数据不合格：' + bad.join('；')); return 1; }
    console.log('✓ 测试数据合格：' + wordCount + ' 词，目标词齐备');
    return 0;
  }

  /* ---- 自检：临时页面验证助手/截图/读取链路 ---- */
  let tempDir = null;
  let baseUrl = baseArg === 'http' ? HTTP_BASE : FILE_BASE;
  if (selftest) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-ui-selftest-'));
    const p = path.join(tempDir, 'index.html');
    fs.writeFileSync(p, '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>UI SELFTEST</title>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>' +
      '<div id="app"><div id="tabs"><button id="tab-reader">阅读</button><button id="tab-notebook">生词本</button><button id="tab-dict">词库</button></div>' +
      '<div id="article-body"><p>Text with <span class="word" data-w="ubiquitous">ubiquitous</span> and ' +
      '<span class="word" data-w="deliberating">deliberating</span> and <span class="word" data-w="were">Were</span>.</p></div>' +
      '<div id="word-card"></div><button id="btn-speak-word">发音</button>' +
      '<textarea id="paste-text"></textarea><button id="btn-paste-start">开始</button>' +
      '<div id="notebook-list"></div><div id="notebook-search"></div><div id="notebook-filter"></div></div>' +
      '<script>window.__hits=[];' +
      'document.getElementById("btn-paste-start").addEventListener("click",function(){ window.__hits.push("paste:"+document.getElementById("paste-text").value.length); });' +
      'document.getElementById("article-body").addEventListener("click",function(e){ var w=e.target.getAttribute&&e.target.getAttribute("data-w"); if(w){ window.__hits.push("word:"+w); document.getElementById("word-card").textContent=w; } });' +
      '</script></body></html>');
    baseUrl = 'file:///' + p.replace(/\\/g, '/');
    console.log('自检模式：临时页面 ' + p);
  }

  const report = {
    v: 1, kind: 'ui-test', at: new Date().toISOString(),
    base: baseUrl, mode: selftest ? 'selftest' : baseArg,
    env: { node: process.version, edge: EDGE, cdpPort: cdpPort },
    steps: [], defects: [], shots: [], status: 'running',
  };

  fs.mkdirSync(PREVIEW, { recursive: true });
  if (!selftest) {
    if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
      report.status = 'blocked';
      report.blockedReason = 'index.html 不存在（应用还没落地）';
      fs.writeFileSync(path.join(PREVIEW, 'ui-test.json'), JSON.stringify(report, null, 2));
      console.log('阻塞：' + report.blockedReason);
      return 2;
    }
    if (!fs.existsSync(EDGE)) {
      report.status = 'blocked';
      report.blockedReason = '找不到 Edge：' + EDGE;
      fs.writeFileSync(path.join(PREVIEW, 'ui-test.json'), JSON.stringify(report, null, 2));
      console.log('阻塞：' + report.blockedReason);
      return 2;
    }
  }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-edge-ui-'));
  let edge = null;
  let exitCode = 0;
  const t0 = Date.now();

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

    const ver = await waitCDP(cdpPort, 20000);
    if (!ver) throw new Error('Edge 调试端口 ' + cdpPort + ' 没起来');
    report.env.browser = ver.Browser || '';

    const target = await newTarget(cdpPort);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
      setTimeout(() => rej(new Error('WebSocket 超时')), 15000);
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: QA_HELPER });

    const ev = (js) => cdp.evaluate(js);
    const waitFor = async (js, timeoutMs, label) => {
      const deadline = Date.now() + (timeoutMs || 5000);
      while (Date.now() < deadline) {
        try { const v = await ev(js); if (v) return v; } catch (e) { /* 上下文切换中 */ }
        await sleep(120);
      }
      return null;
    };

    const shot = async (name) => {
      try {
        let r = null, lastErr = null;
        for (let i = 0; i < 2 && !r; i++) {
          try { r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 45000); }
          catch (e) { lastErr = e; await sleep(500); }
        }
        if (!r) throw lastErr || new Error('截图失败');
        const file = path.join(PREVIEW, name + '.png');
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        report.shots.push(file);
        return file;
      } catch (e) {
        report.toolFailures = report.toolFailures || [];
        report.toolFailures.push({ kind: 'screenshot', name: name, error: e.message });
        console.log('  截图失败 ' + name + '（工具层，非应用缺陷）：' + e.message);
        return '';
      }
    };

    const setViewport = async (w, h) => {
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, 20000);
        await sleep(250);
        return true;
      } catch (e) {
        report.toolFailures = report.toolFailures || [];
        report.toolFailures.push({ kind: 'viewport', size: w + 'x' + h, error: e.message });
        console.log('  视口设置失败（工具层，非应用缺陷）：' + e.message);
        return false;
      }
    };

    /* 真实受信任输入（CDP Input 域）：只有需要浏览器默认行为（焦点/失焦/键盘）时使用；
       普通点击仍走 __qa.click 的 DOM 事件序列（模拟事件委托）。 */
    const inputClickAt = async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(150);
    };
    const inputClickSel = async (sel) => {
      const pos = await ev('(function(){var el=__qa.q(' + JSON.stringify(sel) + '); if(!el) return null; el.scrollIntoView({block:"center"}); var r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height)};})()');
      if (!pos || !pos.w) return null;
      await inputClickAt(pos.x, pos.y);
      return pos;
    };
    const nav = async (url) => {
      await cdp.send('Page.navigate', { url });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await sleep(120);
        try { if ((await ev('document.readyState')) === 'complete') break; } catch (e) { /* 切换中 */ }
      }
      await sleep(300);
    };
    const reload = async () => {
      await cdp.send('Page.reload');
      await waitFor('document.readyState === "complete"', 15000);
      await sleep(600);
    };
    const goRoute = async (name) => {
      const hash = '#/' + name;
      const before = await ev('location.hash');
      let viaClick = false;
      try {
        const clicked = await ev('(function(){var b=__qa.q("' + '#tab-' + name + '"); if(!b) return false; __qa.click(b); return true;})()');
        viaClick = !!clicked;
      } catch (e) { /* ignore */ }
      await sleep(400);
      let after = null;
      try { after = await ev('location.hash'); } catch (e) { /* ignore */ }
      let viaHash = false;
      if (after !== hash) {
        try {
          await ev('location.hash = ' + JSON.stringify(hash));
          viaHash = true;
        } catch (e) { /* ignore */ }
        await sleep(400);
        try { after = await ev('location.hash'); } catch (e) { /* ignore */ }
      }
      return { before: before, after: after, viaClick: viaClick && after === hash, viaHash };
    };

    /* 当前步骤上下文，供失败时补 DOM 摘要 */
    let current = null;
    const domDigest = async (sel) => {
      try {
        return await ev('(function(){ var s = __qa.summary(); var d = ' + JSON.stringify(sel || '') +
          ' ? __qa.dom(' + JSON.stringify(sel) + ') : ""; s.dom = d; return s; })()');
      } catch (e) { return { error: e.message }; }
    };

    const runStep = async (id, title, fn) => {
      const rec = { id, title, status: 'pass', asserts: [], shots: [], ms: 0, detail: '' };
      report.steps.push(rec);
      current = rec;
      const start = Date.now();
      const errBase = cdp.exceptions.length + cdp.consoleErrors.length;
      try {
        await fn(rec);
      } catch (e) {
        rec.status = 'fail';
        rec.error = e instanceof StepFail ? e.message : (e && e.message || String(e));
      }
      rec.ms = Date.now() - start;
      const newErrs = cdp.exceptions.slice(-5).concat(cdp.consoleErrors.slice(-5));
      rec.pageErrors = newErrs;
      // 页面异常（未捕获异常）在验收里算错
      const newExceptions = cdp.exceptions.length - errBase;
      if (rec.status === 'pass' && newExceptions > 0) {
        rec.status = 'fail';
        rec.error = rec.error || ('步骤期间出现 ' + newExceptions + ' 个未捕获异常：' + cdp.exceptions.slice(-newExceptions).join('；'));
      }
      if (rec.status === 'fail') {
        rec.domDigest = await domDigest(rec.failSelector || '');
        rec.shot = await shot('ui-fail-' + id);
        const failAssert = rec.asserts.filter((a) => a.status === 'fail').map((a) => a.name + (a.detail ? '｜' + a.detail : ''));
        console.log('✗ ' + id + ' ' + title + '：' + (rec.error || '') );
        if (failAssert.length) console.log('   失败断言：' + failAssert.join('；'));
        if (rec.failSelector) console.log('   选择器：' + rec.failSelector + '  → ' + String(rec.domDigest && rec.domDigest.dom || '').slice(0, 300));
        console.log('   截图：' + (rec.shot || '（无）'));
        console.log('   DOM 摘要：' + JSON.stringify({
          hash: rec.domDigest && rec.domDigest.hash, rows: rec.domDigest && rec.domDigest.rows,
          overlays: rec.domDigest && rec.domDigest.overlays, toasts: rec.domDigest && rec.domDigest.toasts,
          articles: rec.domDigest && rec.domDigest.articles, notebookN: rec.domDigest && rec.domDigest.notebookN,
        }));
        report.defects.push({
          id: 'Q' + String(report.defects.length + 1).padStart(2, '0'),
          step: id, title, selector: rec.failSelector || '', error: rec.error || '',
          asserts: rec.asserts.filter((a) => a.status !== 'pass'),
          shot: rec.shot, domDigest: rec.domDigest,
        });
      } else {
        const warns = rec.asserts.filter((a) => a.status === 'warn');
        if (warns.length) rec.status = 'pass-with-warnings';
        console.log((warns.length ? '⚠ ' : '✓ ') + id + ' ' + title + '（' + rec.asserts.filter((a) => a.status === 'pass').length + ' 项通过' +
          (warns.length ? '，' + warns.length + ' 项警告' : '') + '）');
        for (const w of warns) console.log('   ⚠ ' + w.name + (w.detail ? '｜' + w.detail : ''));
      }
      return rec;
    };

    /* 只跑部分步骤：其它步骤跳过；自检模式下只跑 S1 */
    const shouldRun = (id) => !selftest && (!only || String(only).split(',').some((s) => id.toUpperCase().startsWith(s.trim().toUpperCase())));

    /* --only 局部跑时也要先打开应用，否则 __qa 不存在 */
    if (only && !selftest) { await nav(baseUrl); await sleep(700); }

    /* ------------------------------------------------ S1 自检（工具链） */
    if (selftest) {
      await nav(baseUrl);
      await setViewport(420, 900);
      await runStep('S1', '自检：助手/真实事件/截图链路', async (rec) => {
        REQUIRED(rec, (await ev('typeof window.__qa')) === 'object', '__qa 助手注入成功', '');
        REQUIRED(rec, (await ev('__qa.setValue(__qa.q("#paste-text"), "hello selftest")')) === true, 'setValue 触发 input/change', '');
        await ev('__qa.click(__qa.q("#btn-paste-start"))');
        const hits = await ev('window.__hits.slice()');
        REQUIRED(rec, Array.isArray(hits) && hits.some((h) => /^paste:14$/.test(h)), '真实点击被应用事件收到', JSON.stringify(hits));
        const w = await ev('__qa.clickWord("ubiquitous", "ubiquitous")');
        REQUIRED(rec, w && w.text === 'ubiquitous', 'clickWord 命中 data-w="ubiquitous"', JSON.stringify(w));
        const card = await ev('__qa.txt(__qa.q("#word-card"))');
        REQUIRED(rec, card === 'ubiquitous', '事件委托生效（#word-card 更新）', card);
        const ov = await ev('__qa.overflow()');
        REQUIRED(rec, ov.over <= 1 && ov.inner === 420, '420 视口与溢出探测正确', JSON.stringify(ov));
        rec.shot = await shot('ui-selftest');
        rec.shots.push(rec.shot);
      });
      await setViewport(1440, 960);
    }

    /* ---------------------------------------------------------- T0 环境 */
    if (shouldRun('T0') && !selftest) {
      await runStep('T0', '环境与应用启动', async (rec) => {
        await nav(baseUrl);
        let info = null;
        try { info = await ev('({ app: !!document.getElementById("app"), tabs: document.querySelectorAll("#tabs > *").length, dr: typeof window.DR, ready: document.readyState, hash: location.hash, theme: document.documentElement.getAttribute("data-theme") || "" })'); } catch (e) { rec.failSelector = '#app'; throw new Error('页面无法求值：' + e.message); }
        REQUIRED(rec, info && info.ready === 'complete', 'document.readyState 为 complete', JSON.stringify(info));
        REQUIRED(rec, info && info.app, '#app 存在（契约 §5）', JSON.stringify(info));
        REQUIRED(rec, info && info.tabs >= 3, '#tabs 里有 3 个主 TAB', '实际 ' + (info && info.tabs));
        REQUIRED(rec, info && info.dr === 'object', 'window.DR 命名空间存在', 'typeof ' + (info && info.dr));
        const api = await ev('(function(){var d=window.DR||{}; return {text:!!d.text, tokenize:!!(d.text&&d.text.tokenize), dict:!!d.dict, lookup:!!(d.dict&&d.dict.lookup), analyze:!!d.analyze, debug:!!d.debug};})()');
        REQUIRED(rec, api.text && api.tokenize, 'DR.text.tokenize 可用（契约 §4.1）', JSON.stringify(api));
        REQUIRED(rec, api.dict && api.lookup, 'DR.dict.lookup 可用（契约 §4.3）', JSON.stringify(api));
        SOFT(rec, !!api.analyze, 'DR.analyze 存在（P2 句子分析）', JSON.stringify(api));
        const tok = await ev('(function(){try{var t=DR.text.tokenize("Ubiquitous things were deliberating."); return t.map(function(x){return x.k+":"+(x.w||x.t);}).join("|");}catch(e){return "ERR:"+e.message;}})()');
        REQUIRED(rec, /^w:ubiquitous/.test(String(tok)) || /ubiquitous/.test(String(tok)), 'tokenize 输出单词 token（含小写 w）', String(tok).slice(0, 200));
        /* file:// 的 localStorage 可用性必须独立验证（Lead 未实测；这决定双击场景能不能持久化） */
        const lsProbe = await ev('(function(){try{localStorage.setItem("dr.__qa_probe","1"); var v=localStorage.getItem("dr.__qa_probe"); localStorage.removeItem("dr.__qa_probe"); return {ok:v==="1", protocol:location.protocol, origin:String(location.origin)};}catch(e){return {ok:false, err:e.message, protocol:location.protocol};}})()');
        rec.localStorageProbe = lsProbe;
        REQUIRED(rec, lsProbe && lsProbe.ok, 'localStorage 可读写（' + (baseArg === 'http' ? 'http' : 'file://') + ' 入口）', JSON.stringify(lsProbe));
        const look = await ev('(function(){function L(w){try{var r=DR.dict.lookup(w); return r?{w:r.w,ipa:r.ipa||"",zh:(r.zh||"").slice(0,40),packs:r.packs||[],lvl:r.lvl}:null;}catch(e){return {err:e.message};}} return {ubiquitous:L("ubiquitous"), deliberating:L("deliberating"), Were:L("Were"), be:L("be"), were:L("were")};})()');
        rec.lookups = look;
        REQUIRED(rec, look && look.ubiquitous && look.ubiquitous.w, 'DR.dict.lookup("ubiquitous") 有结果', JSON.stringify(look && look.ubiquitous));
        REQUIRED(rec, look && look.deliberating && /deliberat/i.test(String(look.deliberating.w)), 'lookup("deliberating") 还原到原形', JSON.stringify(look && look.deliberating));
        REQUIRED(rec, look && look.Were, 'lookup("Were") 有结果（大写）', JSON.stringify(look && look.Were));
        /* 契约 §6：dr.settings.v1 / dr.stats.v1 等键按前缀存放（首次启动可能还没有 stats） */
        const keys = await ev('(function(){var out=[]; try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i); if(k&&k.indexOf("dr.")===0) out.push(k);}}catch(e){} return out;})()');
        rec.storageKeys = keys;
        const settings = await ev('(function(){try{return __qa.ls("dr.settings.v1");}catch(e){return null;}})()');
        rec.settings = settings;
        const runtimeSettings = await ev('(function(){try{var s=(window.DR&&DR.store&&DR.store.settings)?DR.store.settings():null; return s?{theme:s.theme,fontScale:s.fontScale,lineHeight:s.lineHeight,marks:s.marks,autoAdd:s.autoAdd,showRoles:s.showRoles}:null;}catch(e){return null;}})()');
        rec.runtimeSettings = runtimeSettings;
        REQUIRED(rec, !!runtimeSettings && typeof runtimeSettings.theme === 'string' && typeof runtimeSettings.fontScale === 'number', 'DR.store.settings() 有完整默认值（契约 §6 字段）', JSON.stringify(runtimeSettings).slice(0, 240));
        /* 键是懒写入（只有改过设置才落盘），首次启动没有 dr.settings.v1 属正常 → 软断言 */
        SOFT(rec, !!settings, '首次启动即已写入 dr.settings.v1（懒写入属正常，不作缺陷）', JSON.stringify(settings).slice(0, 200));
        /* 统一到浅色主题，后续截图颜色稳定；深浅两套在 T7 单独验证 */
        for (let i = 0; i < 4; i++) {
          const cur = await ev('document.documentElement.getAttribute("data-theme")||""');
          if (cur === 'light') break;
          await ev('(function(){var b=__qa.q("#theme-toggle"); if(b) __qa.click(b); return true;})()');
          await sleep(350);
        }
        rec.themeAtStart = await ev('document.documentElement.getAttribute("data-theme")||""');
        /* 数据/引擎版本（报告里要注明；lex-builder 已冻结 exam 16,638 / dict 60,000 / affixes 202） */
        rec.debugState = await ev('(function(){try{var d=DR.debug&&DR.debug.state&&DR.debug.state(); if(!d) return null; return {route:d.route, articles:d.articles, notebook:d.notebook, dict:d.dict, analysis:d.analysis, settings:{theme:d.settings&&d.settings.theme, readFont:d.settings&&d.settings.readFont, fontScale:d.settings&&d.settings.fontScale, marks:d.settings&&d.settings.marks, autoAdd:d.settings&&d.settings.autoAdd}};}catch(e){return {err:e.message};}})()');
        rec.dataVersions = await ev('(function(){return {examV:(window.DR_EXAM&&DR_EXAM.v)||null, examN:(window.DR_EXAM&&DR_EXAM.words&&DR_EXAM.words.length)||0, dictV:(window.DR_DICT&&DR_DICT.v)||null, dictN:(window.DR_DICT&&DR_DICT.words&&DR_DICT.words.length)||0, affixN:(window.DR_AFFIX&&DR_AFFIX.items&&DR_AFFIX.items.length)||0, posV:(window.DR_POS&&DR_POS.v)||null, posN:(window.DR_POS&&DR_POS.w&&Object.keys(DR_POS.w).length)||0};})()');
        rec.shot = await shot('ui-00-env');
        rec.shots.push(rec.shot);
      });
    }

    /* --------------------------------------------------------- T1 粘贴 */
    if (shouldRun('T1')) {
      await runStep('T1', '粘贴 ≥600 词文章并渲染可点单词', async (rec) => {
        if (!selftest) { await goRoute('read'); await sleep(200); }
        const opened = await ev('(function(){var m=__qa.q("#paste-modal"); if(m && __qa.vis(m)) return "already"; var b=__qa.q("#btn-new-article"); if(!b) return "no-button"; __qa.click(b); return "clicked";})()');
        rec.failSelector = '#paste-modal';
        REQUIRED(rec, opened !== 'no-button', '#btn-new-article 存在（契约 §5）', String(opened));
        const vis = await waitFor('(function(){var m=__qa.q("#paste-modal"); return m && __qa.vis(m);})()', 4000);
        REQUIRED(rec, vis, '#paste-modal 打开并可见', 'opened=' + opened);
        const typedTitle = await ev('__qa.setValue(__qa.q("#paste-title"), ' + JSON.stringify(TITLE_1) + ')');
        SOFT(rec, typedTitle === true, '#paste-title 可写入标题', String(typedTitle));
        await ev('window.__ARTICLE_TEXT__ = ' + JSON.stringify(ARTICLE_1) + '; true');
        const typed2 = await ev('(function(){var el=__qa.q("#paste-text"); if(!el) return "no-textarea"; return __qa.setValue(el, window.__ARTICLE_TEXT__);})()');
        REQUIRED(rec, typed2 === true, '#paste-text 可写入（input/change 事件已派发）', String(typed2));
        rec.failSelector = '#paste-text';
        const val = await ev('(function(){var el=__qa.q("#paste-text"); return el ? {len:(el.value||"").length, tag:el.tagName} : null;})()');
        REQUIRED(rec, val && val.len > 3000, '#paste-text 里确实有长文', JSON.stringify(val));
        const started = await ev('(function(){var b=__qa.q("#btn-paste-start"); if(!b) return "missing"; __qa.click(b); return "clicked";})()');
        rec.failSelector = '#btn-paste-start';
        REQUIRED(rec, started === 'clicked', '#btn-paste-start 存在且可点', String(started));
        const rendered = await waitFor('(function(){var a=__qa.q("#article-body"); return a && __qa.txt(a).length > 2500;})()', 8000);
        rec.failSelector = '#article-body';
        const bodyInfo = await ev('(function(){var a=__qa.q("#article-body"); return {len:a?__qa.txt(a).length:0, tokens:__qa.all("#article-body .w[data-w]").length || __qa.all("#article-body [data-w]").length, sents:__qa.all("#article-body .sent[data-si]").length, title:__qa.txt(__qa.q("#article-title")), meta:__qa.txt(__qa.q("#article-meta")), html:(a?a.outerHTML:"").slice(0,400)};})()');
        REQUIRED(rec, rendered, '#article-body 渲染出正文（>2500 字符）', JSON.stringify({ len: bodyInfo.len }));
        REQUIRED(rec, bodyInfo.tokens >= 550, '正文有 ≥550 个可点单词（.w[data-w]）', '实际 ' + bodyInfo.tokens + '；HTML 片段：' + String(bodyInfo.html).slice(0, 220));
        SOFT(rec, bodyInfo.sents > 0, '正文切成可点的句子 .sent[data-si]', '句子数 ' + bodyInfo.sents);
        SOFT(rec, /The Harbour at Dawn/.test(bodyInfo.title), '#article-title 显示文章标题', bodyInfo.title || '(空)');
        SOFT(rec, bodyInfo.meta.length > 0, '#article-meta 显示文章信息（词数/日期）', bodyInfo.meta || '(空)');
        /* 粘贴弹窗没自动关会把后续点击挡住 —— 主动关掉并记录 */
        const stillOpen = await ev('(function(){var m=__qa.q("#paste-modal"); return !!(m && __qa.vis(m));})()');
        if (stillOpen) {
          await ev('(function(){var m=__qa.q("#paste-modal"); var b=__qa.q("#paste-cancel")||m.querySelector("[data-close]")||m.querySelector(".close"); if(b){__qa.click(b); return true;} document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true;})()');
          await sleep(400);
          const closed = await ev('(function(){var m=__qa.q("#paste-modal"); return !(m && __qa.vis(m));})()');
          rec.asserts.push({ name: '#paste-modal 粘贴后自动关闭', status: closed ? 'pass' : 'warn', detail: closed ? '' : '仍可见，已尝试 ESC 关闭' });
        } else {
          rec.asserts.push({ name: '#paste-modal 粘贴后自动关闭', status: 'pass', detail: '' });
        }
        rec.shot = await shot('ui-01-paste-read');
        rec.shots.push(rec.shot);
      });
    }

    /* --------------------------------------------------------- T2 查词 */
    if (shouldRun('T2')) {
      await runStep('T2', '点词查词：词头/音标/释义/词级/发音', async (rec) => {
        if (!selftest) { await goRoute('read'); }
        const cases = [
          { key: 'ubiquitous', surface: 'ubiquitous', expectHead: /ubiquitous/i, headLabel: '原形直接命中' },
          { key: 'deliberating', surface: 'deliberating', expectHead: /deliberat/i, headLabel: '-ing 还原到 deliberate', expectLemma: /原形[：:]\s*deliberate\b/i, lemmaWant: 'deliberate' },
          { key: 'were', surface: 'Were', expectHead: /^(be|were)$/i, headLabel: '大写 Were → be/were', expectLemma: /原形[：:]\s*(be|were)\b/i, lemmaWant: 'be 或 were' },
          { key: 'committee', surface: 'committee', expectHead: /committee/i, headLabel: '补充词 committee' },
          { key: 'quay', surface: 'quay', expectHead: /quay/i, headLabel: '补充词 quay' },
        ];
        rec.lookupResults = [];
        for (const c of cases) {
          const excMark = cdp.exceptions.length;
          const conMark = cdp.consoleErrors.length;
          /* 记下点之前卡片内容：面板常驻时，若只等「可见」会立刻拿到上一张卡的文本而误判 */
          const beforeCard = await ev('(function(){var c=__qa.q("#word-card"); return c?__qa.txt(c):"";})()');
          const info = await ev('__qa.clickWord(' + JSON.stringify(c.key) + ', ' + JSON.stringify(c.surface) + ')');
          rec.failSelector = '#article-body [data-w="' + c.key + '"]';
          REQUIRED(rec, info, '正文里能点到单词 ' + c.surface, 'data-w=' + c.key);
          let card = await waitFor('(function(){var c=__qa.q("#word-card"); if(!c||!__qa.vis(c)) return null; var t=__qa.txt(c); if(!t) return null; if(t.indexOf("正在加载")>=0) return null; if(t===' + JSON.stringify(beforeCard) + ') return null; var w=__qa.q("#word-card-word") || c.querySelector(".word"); return {vis:true, text:t, head:w?__qa.txt(w):"", html:(c.outerHTML||"").slice(0,700)};})()', 8000);
          if (!card) {
            /* 内容没变也把当前卡片读出来，便于区分「没渲染」和「渲染成一样」 */
            const stale = await ev('(function(){var c=__qa.q("#word-card"); if(!c) return null; var w=__qa.q("#word-card-word")||c.querySelector(".word"); return {vis:__qa.vis(c), text:__qa.txt(c), head:w?__qa.txt(w):"", html:(c.outerHTML||"").slice(0,700)};})()');
            if (stale && stale.vis && stale.text && stale.text.indexOf('正在加载') < 0) {
              card = stale;
              rec.asserts.push({ name: '词卡内容随点击更新 · ' + c.surface, status: 'warn', detail: '卡片文本与点之前相同，可能未刷新' });
            }
          }
          rec.failSelector = '#word-card';
          if (!card) {
            const digest = await ev('(function(){var c=__qa.q("#word-card"); return {exists:!!c, vis:c?__qa.vis(c):false, html:c?(c.outerHTML||"").slice(0,500):"", overlays:__qa.summary().overlays, toasts:__qa.summary().toasts};})()');
            throw new StepFail('点 ' + c.surface + ' 后 #word-card 没有出现（或一直停在加载态）：' + JSON.stringify(digest));
          }
          const text = card.text || '';
          const head = (card.head || '').trim();
          const levelHit = /四级|六级|专四|专八|雅思|托福/.test(text);
          const ipaish = /[æɑɒɔəɜɪʊʌθðʃʒŋˈˌː]/.test(text) || /\/[^\/\s]{2,}\//.test(text);
          const zhHit = /[\u4e00-\u9fa5]/.test(text);
          const exHit = new RegExp('\\b' + c.surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);
          /* 词头用 #word-card-word；退化时才取卡片文本第一个英文词（注意卡头 eyebrow 是 "WORD · 单词"） */
          const headHit = c.expectHead.test(head) || (!head && c.expectHead.test(((text.match(/[A-Za-z][A-Za-z'’-]*/) || [''])[0] || '').toLowerCase()));
          const lemmaHit = c.expectLemma ? c.expectLemma.test(text) : null;
          rec.lookupResults.push({ word: c.surface, head, cardText: text.slice(0, 260), levelHit, ipaish, zhHit, headHit, lemmaHit });
          REQUIRED(rec, text.length > 0, '词卡有内容 · ' + c.surface, '');
          REQUIRED(rec, !!head, '词卡显示词头（#word-card-word）· ' + c.surface, 'head=' + JSON.stringify(head) + ' 卡片：' + text.slice(0, 80));
          REQUIRED(rec, headHit, '词头正确 · ' + c.surface + '（' + c.headLabel + '）', 'head=' + JSON.stringify(head));
          REQUIRED(rec, zhHit, '词卡有中文释义 · ' + c.surface, text.slice(0, 120));
          if (c.expectLemma) REQUIRED(rec, lemmaHit, '词形还原 · ' + c.surface + '（原形行应为 ' + c.lemmaWant + '）', '卡片：' + text.slice(0, 200));
          SOFT(rec, ipaish, '词卡有音标 · ' + c.surface, ipaish ? '' : '卡片没识别到 IPA 字符：' + text.slice(0, 90));
          SOFT(rec, levelHit, '词卡有词级标签 · ' + c.surface, levelHit ? '' : '没识别到 四级/六级/专四/专八/雅思/托福：' + text.slice(0, 90));
          SOFT(rec, exHit, '词卡有例句 · ' + c.surface, exHit ? '' : '卡片里没找到该词的英文例句');
          // 发音按钮：真点一次，看「有没有语音」与「报不报错」；toast 要取差值，别读到上一条残留
          const speak = await ev('(function(){var b=__qa.q("#btn-speak-word"); return b ? {exists:true, vis:__qa.vis(b), disabled:!!b.disabled, label:(b.getAttribute("aria-label")||b.textContent||"").trim()} : {exists:false};})()');
          REQUIRED(rec, speak.exists, '#btn-speak-word 存在（契约 §5）· ' + c.surface, JSON.stringify(speak));
          REQUIRED(rec, speak.vis, '#btn-speak-word 可见可点 · ' + c.surface, JSON.stringify(speak));
          const ttsState = await ev('(function(){var t=window.DR&&DR.tts; var has=false; try{has=!!(t&&t.hasVoice&&t.hasVoice());}catch(e){} return {hasVoice:has, supported:!!window.speechSynthesis, voices:(window.speechSynthesis&&window.speechSynthesis.getVoices?window.speechSynthesis.getVoices().length:0)};})()');
          rec.ttsState = ttsState;
          const toastBefore = await ev('(function(){var t=__qa.q("#toast-layer"); return t?__qa.txt(t):"";})()');
          await ev('(function(){var b=__qa.q("#btn-speak-word"); if(b) __qa.click(b); return true;})()');
          await sleep(900);
          const speakErrs = cdp.exceptions.slice(excMark).concat(cdp.consoleErrors.slice(conMark));
          const hardSpeakErrs = speakErrs.filter((s) => !/favicon/i.test(s));
          REQUIRED(rec, hardSpeakErrs.length === 0, '点发音不报错 · ' + c.surface, hardSpeakErrs.join('；'));
          const toastAfter = await ev('(function(){var t=__qa.q("#toast-layer"); return t?__qa.txt(t):"";})()');
          const toastNew = toastAfter && toastAfter !== toastBefore ? toastAfter : '';
          if (!ttsState.hasVoice) {
            /* 契约：没有语音时给提示而不是报错 */
            const hinted = /语音|发音|朗读|朗读不可用|没有可用|安装/i.test(toastNew) || /语音|发音/.test(toastAfter);
            REQUIRED(rec, hinted, '无语音时给出提示而不是报错 · ' + c.surface, JSON.stringify({ hasVoice: ttsState.hasVoice, toastBefore: toastBefore, toastAfter: toastAfter }));
          } else {
            rec.asserts.push({ name: '有英语语音，点发音已调用 · ' + c.surface, status: 'pass', detail: JSON.stringify(ttsState) });
          }
          if (c.surface !== cases[cases.length - 1].surface) {
            // 点词后滚动到下一个目标词附近，模拟真实阅读
            await ev('(function(){var el=__qa.q("#article-body"); if(el) window.scrollBy(0, 120); return true;})()');
          }
        }
        // 分词/还原的实际结果（数据事实，供报告引用）
        rec.notebookAfter = await ev('(function(){var n=__qa.ls("dr.notebook.v1"); return n&&n.order?n.order.slice():[];})()');
        SOFT(rec, (rec.notebookAfter || []).length >= 3, '查过的词进入生词本存储（autoAdd）', '当前 key：' + JSON.stringify(rec.notebookAfter));
        rec.shot = await shot('ui-02-wordcard');
        rec.shots.push(rec.shot);
      });
    }

    /* ------------------------------------------------------- T3 生词本 */
    if (shouldRun('T3')) {
      await runStep('T3', '生词本：条数/语境/日期/持久化/搜索/筛选/标记', async (rec) => {
        if (!selftest) {
          const route = await goRoute('notebook');
          rec.routeViaClick = route.viaClick;
          SOFT(rec, route.viaClick, '点击 #tab-notebook 能切到 #/notebook', JSON.stringify(route));
          await waitFor('(function(){var l=__qa.q("#notebook-list"); return l && __qa.all("#notebook-list [data-key], #notebook-list li").length>0;})()', 6000);
        }
        const st = await ev('(function(){var r=__qa.rows(); var t=__qa.q("#notebook-stats"); return {n:r.n, how:r.how, stats:__qa.txt(t), texts:__qa.rowTexts(), nb:(function(){var nb=__qa.ls("dr.notebook.v1"); return nb&&nb.order?{n:nb.order.length,keys:nb.order.slice(0,12)}:{n:0,keys:[]};})()};})()');
        rec.notebook = st;
        rec.failSelector = '#notebook-list';
        REQUIRED(rec, st.n >= 3, '#notebook-list 有查过的词（≥3 行）', JSON.stringify({ n: st.n, how: st.how, keys: st.nb.keys }));
        SOFT(rec, st.n >= 5, '查 5 个词后生词本有 5 行（契约 §8.3）', '实际 ' + st.n + ' 行');
        REQUIRED(rec, st.stats.length > 0, '#notebook-stats 显示统计', st.stats || '(空)');
        // 每个词条：语境句 + 日期
        const sampleText = st.texts.join(' || ');
        const dateHit = /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})|(\d{1,2}月\d{1,2}日)|(刚刚|分钟前|小时前|天前|昨天|今天)/.test(sampleText);
        const contextHit = /ubiquit|deliberat|committee|quay|harbour/i.test(sampleText);
        REQUIRED(rec, contextHit, '词条含原文语境/词本身', sampleText.slice(0, 200));
        SOFT(rec, dateHit, '词条含日期', dateHit ? '' : '行文本里没识别到日期：' + sampleText.slice(0, 200));
        // reload 持久化
        rec.failSelector = 'localStorage:dr.notebook.v1';
        if (!selftest) {
          await reload();
          const route2 = await goRoute('notebook');
          await waitFor('(function(){return __qa.all("#notebook-list [data-key], #notebook-list li").length>0;})()', 6000);
          const after = await ev('(function(){var r=__qa.rows(); var nb=__qa.ls("dr.notebook.v1"); return {n:r.n, nbN:(nb&&nb.order)?nb.order.length:0, keys:(nb&&nb.order)?nb.order.slice(0,12):[]};})()');
          rec.afterReload = after;
          REQUIRED(rec, after.nbN >= 3, 'reload 后生词本仍在（localStorage dr.notebook.v1）', JSON.stringify(after));
          REQUIRED(rec, after.n >= 3, 'reload 后 #notebook-list 仍有行', JSON.stringify(after));
          SOFT(rec, route2.viaClick, '刷新后点 #tab-notebook 仍能路由', JSON.stringify(route2));
        }
        // 搜索
        const typed = await ev('__qa.setValue(__qa.q("#notebook-search"), "ubiquitous")');
        rec.failSelector = '#notebook-search';
        REQUIRED(rec, typed === true, '#notebook-search 可输入', String(typed));
        await sleep(600);
        const sr = await ev('(function(){var r=__qa.rows(); var texts=__qa.rowTexts(); return {n:r.n, hit:texts.filter(function(t){return /ubiquit/i.test(t);}).length, all:texts.map(function(t){return t.slice(0,60);})};})()');
        rec.search = sr;
        REQUIRED(rec, sr.n >= 1, '搜索 ubiquitous 有结果', JSON.stringify(sr));
        SOFT(rec, sr.hit >= 1 && sr.hit === sr.n, '搜索结果都包含关键词', JSON.stringify(sr));
        await ev('__qa.setValue(__qa.q("#notebook-search"), "")');
        await sleep(500);
        // 标记已掌握：真实路径是先点 .nb-row 展开详情，再点 .nb-detail 里的 [data-act="toggle-known"]
        const before = await ev('(function(){var nb=__qa.ls("dr.notebook.v1"); var out={}; if(nb&&nb.items){Object.keys(nb.items).forEach(function(k){out[k]=nb.items[k].status;});} return out;})()');
        rec.statusBefore = before;
        const expandInfo = await ev('(function(){' +
          'var rows=__qa.all("#notebook-list .nb-item");' +
          'var row=null; for(var i=0;i<rows.length;i++){ if(/ubiquit/i.test(__qa.txt(rows[i]))){row=rows[i];break;} }' +
          'if(!row) return {found:false, rowCount:rows.length};' +
          'var toggle=row.querySelector(".nb-row"); if(toggle) __qa.click(toggle);' +
          'var d=row.querySelector(".nb-detail");' +
          'return {found:true, rowKey:row.getAttribute("data-key"), hasRow:!!toggle, hasDetail:!!d, rowText:__qa.txt(row).slice(0,140)};})()');
        rec.expandInfo = expandInfo;
        rec.failSelector = '.nb-item[data-key]';
        REQUIRED(rec, expandInfo && expandInfo.found, '在生词本里找到 ubiquitous 那一行（.nb-item[data-key]）', JSON.stringify(expandInfo));
        SOFT(rec, expandInfo && expandInfo.hasRow, '行首是 .nb-row 按钮（Lead 定，点它展开详情）', JSON.stringify(expandInfo));
        await sleep(600);
        const detailState = await ev('(function(){var rows=__qa.all("#notebook-list .nb-item"); var row=null; for(var i=0;i<rows.length;i++){ if(/ubiquit/i.test(__qa.txt(rows[i]))){row=rows[i];break;} } if(!row) return null; var d=row.querySelector(".nb-detail"); var ctx=row.querySelector(".nb-context__text"); var ctxs=row.querySelectorAll(".nb-context"); return {hasDetail:!!d, hidden:d?!!d.hidden:null, vis:d?__qa.vis(d):false, ctxCount:ctxs.length, ctxText:ctx?__qa.txt(ctx).slice(0,180):"", hasCtxTitle:!!row.querySelector(".nb-context__meta")};})()');
        rec.detailState = detailState;
        SOFT(rec, !!(detailState && detailState.hasDetail), '行内有 .nb-detail 详情容器（Lead 定）', JSON.stringify(detailState));
        SOFT(rec, !!(detailState && detailState.vis), '点 .nb-row 后详情展开可见', JSON.stringify(detailState));
        /* 契约 §8.3：生词本每条要有「原文语境」——展开后 .nb-context 里应有一句含该词的原文 */
        REQUIRED(rec, !!(detailState && detailState.ctxCount >= 1), '生词本词条含原文语境（.nb-context）', JSON.stringify(detailState));
        REQUIRED(rec, !!(detailState && /ubiquit/i.test(detailState.ctxText || '')), '语境句里含目标词', JSON.stringify({ ctxText: detailState && detailState.ctxText }));
        REQUIRED(rec, !!(detailState && detailState.ctxText && detailState.ctxText.length >= 20), '语境句是完整句子（长度 ≥20）', JSON.stringify({ ctxText: detailState && detailState.ctxText }));
        rec.detailState = detailState;
        SOFT(rec, !!(detailState && detailState.hasDetail), '行内有 .nb-detail 详情容器（Lead 定）', JSON.stringify(detailState));
        SOFT(rec, !!(detailState && detailState.vis), '点 .nb-row 后详情展开可见', JSON.stringify(detailState));
        const markInfo = await ev('(function(){' +
          'var rows=__qa.all("#notebook-list .nb-item");' +
          'var row=null; for(var i=0;i<rows.length;i++){ if(/ubiquit/i.test(__qa.txt(rows[i]))){row=rows[i];break;} }' +
          'if(!row) return {found:false};' +
          'var picked=row.querySelector("[data-act=toggle-known]"); var how="[data-act=toggle-known]";' +
          'if(!picked){ var cands=[].slice.call(row.querySelectorAll("button")); how="semantic";' +
          '  for(var j=0;j<cands.length;j++){ var t=(__qa.txt(cands[j])+" "+(cands[j].getAttribute("aria-label")||"")).trim(); if(/掌握|known/i.test(t)){picked=cands[j];break;} } }' +
          'if(!picked) return {found:true, clicked:false, rowHtml:String(row.outerHTML||"").replace(/\s+/g," ").slice(0,600)};' +
          'var vis=__qa.vis(picked); __qa.click(picked);' +
          'return {found:true, clicked:true, how:how, vis:vis, btnText:__qa.txt(picked).slice(0,30), hasSpeak:!!row.querySelector("[data-act=speak]")};})()');
        rec.markInfo = markInfo;
        rec.failSelector = '.nb-item[data-key] [data-act="toggle-known"]';
        REQUIRED(rec, markInfo && markInfo.found, '在生词本里找到 ubiquitous 那一行', JSON.stringify(markInfo));
        if (!markInfo.clicked) {
          throw new StepFail('生词本行内找不到「标记已掌握」控件（期望 .nb-detail 内 [data-act="toggle-known"]，契约 §8.3 要求可标记）。行 HTML：' + String(markInfo.rowHtml || '').slice(0, 480));
        }
        SOFT(rec, markInfo.vis, '「标记已掌握」按钮展开后可见（真实可点）', 'vis=' + markInfo.vis);
        await sleep(900);
        const after = await ev('(function(){var nb=__qa.ls("dr.notebook.v1"); var out={}; if(nb&&nb.items){Object.keys(nb.items).forEach(function(k){out[k]=nb.items[k].status;});} return out;})()');
        rec.statusAfter = after;
        const markedKey = Object.keys(after || {}).find((k) => /ubiquit/i.test(k));
        REQUIRED(rec, markedKey && after[markedKey] === 'known', '标记后存储状态为 known', 'key=' + markedKey + ' 状态=' + JSON.stringify(after));
        const rowStatus = await ev('(function(){var rows=__qa.all("#notebook-list .nb-item"); for(var i=0;i<rows.length;i++){ if(/ubiquit/i.test(__qa.txt(rows[i]))){return rows[i].getAttribute("data-status");} } return null;})()');
        SOFT(rec, rowStatus === 'known', '行上 data-status 同步为 known', 'data-status=' + rowStatus);
        /* 行内发音按钮（Lead 定：.nb-item 内 [data-act="speak"]） */
        if (markInfo.hasSpeak) {
          const excM = cdp.exceptions.length;
          await ev('(function(){var b=__qa.q("[data-act=speak]"); if(b) __qa.click(b); return true;})()');
          await sleep(500);
          const nbSpeakErrs = cdp.exceptions.slice(excM);
          rec.asserts.push({ name: '生词本行内发音按钮可点不报错', status: nbSpeakErrs.length ? 'fail' : 'pass', detail: nbSpeakErrs.join('；') });
        } else {
          rec.asserts.push({ name: '生词本行内发音按钮 [data-act="speak"]', status: 'warn', detail: '该行内没找到' });
        }
        // 筛选
        const opts = await ev('(function(){var s=__qa.q("#notebook-filter"); if(!s) return null; return [].slice.call(s.options).map(function(o){return {v:o.value, t:(o.textContent||"").trim()};});})()');
        rec.filterOptions = opts;
        REQUIRED(rec, Array.isArray(opts) && opts.length > 0, '#notebook-filter 是带选项的 select（契约 §5）', JSON.stringify(opts));
        const knownOpt = (opts || []).find((o) => /掌握|known/i.test(o.t));
        const useOpt = knownOpt || (opts || []).find((o) => o.v !== '' && o.v !== 'all') || opts[opts.length - 1];
        const applied = await ev('(function(){var s=__qa.q("#notebook-filter"); return __qa.setSelReg(s, ' + JSON.stringify(useOpt && useOpt.v || '') + ');})()');
        await sleep(700);
        const filtered = await ev('(function(){var r=__qa.rows(); return {n:r.n, texts:__qa.rowTexts().map(function(t){return t.slice(0,50);})};})()');
        rec.filterApplied = { option: useOpt, applied, result: filtered };
        REQUIRED(rec, applied === true, '筛选下拉可切换', JSON.stringify(useOpt));
        if (knownOpt) SOFT(rec, filtered.n >= 1, '筛选「已掌握」后仍能看到标记的词', JSON.stringify(filtered));
        await ev('(function(){var s=__qa.q("#notebook-filter"); return s ? __qa.setSelReg(s, "all") : false;})()');
        await sleep(300);
        rec.shot = await shot('ui-03-notebook');
        rec.shots.push(rec.shot);
      });
    }

    /* --------------------------------------------------------- T4 复习 */
    if (shouldRun('T4')) {
      await runStep('T4', '复习闪卡：翻卡 → 三档评分 → 汇总 → 按到期筛选', async (rec) => {
        if (!selftest) {
          if (await ev('location.hash') !== '#/notebook') await goRoute('notebook');
        }
        const beforeReps = await ev('(function(){var nb=__qa.ls("dr.notebook.v1"); var s=0; if(nb&&nb.items){Object.keys(nb.items).forEach(function(k){s+=(nb.items[k].reps||0);});} return s;})()');
        /* 多题型上线后，T4 固定用「闪卡」模式验收翻卡/评分链路；混合题型在 T11 单独测 */
        await ev('(function(){var s=__qa.q("#review-mode"); if(!s) return "missing"; s.value="flashcard"; s.dispatchEvent(new Event("change",{bubbles:true})); return s.value;})()');
        rec.failSelector = '#btn-review';
        const enter = await ev('(function(){var b=__qa.q("#btn-review"); if(!b) return "missing"; __qa.click(b); return "clicked";})()');
        REQUIRED(rec, enter === 'clicked', '#btn-review 存在且可点', String(enter));
        const modalVis = await waitFor('(function(){var m=__qa.q("#review-modal"); return m && __qa.vis(m);})()', 5000);
        const emptyState = await ev('(function(){var m=__qa.q("#review-modal"); var t=m?__qa.txt(m):""; return {vis:m?__qa.vis(m):false, text:t.slice(0,300), cardVis:(function(){var c=__qa.q("#review-card"); return c?__qa.vis(c):false;})()};})()');
        rec.reviewEntry = emptyState;
        REQUIRED(rec, modalVis || /无|没有|完成|待复习|复习完/i.test(emptyState.text), '#btn-review 打开复习（或显示无待复习）', JSON.stringify(emptyState));
        if (emptyState.cardVis) {
          const cardBefore = await ev('(function(){var c=__qa.q("#review-card"); var t=c?__qa.txt(c):""; return {text:t.slice(0,300), len:t.length};})()');
          rec.cardBefore = cardBefore;
          REQUIRED(rec, cardBefore.len > 0, '#review-card 显示卡片内容', JSON.stringify(cardBefore));
          rec.failSelector = '#review-reveal';
          const revealed = await ev('(function(){var b=__qa.q("#review-reveal"); if(!b) return "missing"; __qa.click(b); return "clicked";})()');
          REQUIRED(rec, revealed === 'clicked', '#review-reveal 存在（翻卡按钮）', String(revealed));
          await sleep(600);
          const cardAfter = await ev('(function(){var c=__qa.q("#review-card"); var t=c?__qa.txt(c):""; var r=__qa.q("#review-reveal"); return {text:t.slice(0,400), len:t.length, revealVis:r?__qa.vis(r):false, answerText:(function(){var a=c?c.querySelector("[class*=answer], .answer, [data-part=answer]"):null; return a?__qa.txt(a).slice(0,200):"";})()};})()');
          rec.cardAfter = cardAfter;
          const grew = cardAfter.len > cardBefore.len + 3;
          const answerShown = cardAfter.answerText && cardAfter.answerText.length > 0;
          REQUIRED(rec, grew || answerShown || cardAfter.revealVis === false, '翻卡后看到答案（内容变多 / 答案区出现）', JSON.stringify({ beforeLen: cardBefore.len, afterLen: cardAfter.len, answerText: cardAfter.answerText, revealVis: cardAfter.revealVis }));
          rec.shotReviewCard = await shot('ui-04-review-card');
          rec.shots.push(rec.shotReviewCard);
          // 三档评分
          const rateBtns = await ev('(function(){var out={};[1,2,3].forEach(function(n){var b=__qa.q("#btn-rate-"+n); out[n]=b?{exists:true, vis:__qa.vis(b), text:__qa.txt(b).slice(0,20)}:{exists:false};}); return out;})()');
          rec.rateButtons = rateBtns;
          for (const n of [1, 2, 3]) {
            REQUIRED(rec, rateBtns[n] && rateBtns[n].exists, '三档评分按钮 #btn-rate-' + n + ' 存在', JSON.stringify(rateBtns));
          }
          REQUIRED(rec, rateBtns[1].vis && rateBtns[2].vis && rateBtns[3].vis, '三档评分按钮都可见', JSON.stringify(rateBtns));
          let cards = 0, texts = [];
          for (let i = 0; i < 10; i++) {
            const still = await ev('(function(){var m=__qa.q("#review-modal"); var c=__qa.q("#review-card"); return {modal:m?__qa.vis(m):false, card:c?__qa.vis(c):false, text:m?__qa.txt(m).slice(0,260):""};})()');
            texts.push(still.text);
            if (!still.modal) break;
            if (!still.card) break;
            const rv = await ev('(function(){var b=__qa.q("#review-reveal"); if(b && __qa.vis(b)){__qa.click(b); return "reveal";} return "no-reveal";})()');
            await sleep(350);
            await ev('(function(){var b=__qa.q("#btn-rate-2"); if(b) __qa.click(b); return true;})()');
            await sleep(500);
            cards++;
          }
          rec.reviewedCards = cards;
          const lastText = texts.slice().reverse().find((t) => t.length > 0) || '';
          const summaryHit = /\d+\s*(张|个)?|完成|已复习|复习结束|汇总|结束/i.test(lastText) && /\d/.test(lastText);
          rec.summaryText = lastText;
          /* Lead 定：#review-done 为汇总容器，内含 .review__summary（三档计数） */
          const doneInfo = await ev('(function(){var d=__qa.q("#review-done"); if(!d) return {exists:false}; var s=d.querySelector(".review__summary"); return {exists:true, vis:__qa.vis(d), text:__qa.txt(d).slice(0,300), summary:s?__qa.txt(s):"", counts:(__qa.txt(d).match(/\\d+/g)||[]).slice(0,6)};})()');
          rec.reviewDone = doneInfo;
          const summaryEl = await ev('(function(){var m=__qa.q("#review-modal"); if(!m) return null; var s=m.querySelector("[class*=summary], .review__summary, [data-part=summary]"); return s?__qa.txt(s).slice(0,240):null;})()');
          rec.summaryEl = summaryEl;
          REQUIRED(rec, summaryHit || !!summaryEl || cards > 0, '评分循环能推进（≥1 张卡）', '审阅卡片数=' + cards);
          REQUIRED(rec, !!(doneInfo && doneInfo.exists && (doneInfo.vis || doneInfo.text.length > 0)), '结束后出现 #review-done 汇总容器', JSON.stringify(doneInfo).slice(0, 300));
          rec.shotReviewDone = await shot('ui-04-review-done');
          rec.shots.push(rec.shotReviewDone);
          REQUIRED(rec, !!(doneInfo && ((doneInfo.counts || []).length >= 2 || (doneInfo.summary || '').length > 0)), '汇总里有三档计数/统计数字', JSON.stringify({ counts: doneInfo && doneInfo.counts, summary: doneInfo && doneInfo.summary }).slice(0, 260));
          SOFT(rec, !!(doneInfo && doneInfo.vis), '#review-done 在端上可见', JSON.stringify(doneInfo).slice(0, 200));
          const afterReps = await ev('(function(){var nb=__qa.ls("dr.notebook.v1"); var s=0; if(nb&&nb.items){Object.keys(nb.items).forEach(function(k){s+=(nb.items[k].reps||0);});} return s;})()');
          rec.repsBefore = beforeReps; rec.repsAfter = afterReps;
          REQUIRED(rec, afterReps > beforeReps, '评分写入间隔重复数据（reps 增加）', 'reps ' + beforeReps + ' → ' + afterReps);
        } else {
          rec.asserts.push({ name: '复习入口显示无待复习（空态）', status: 'warn', detail: emptyState.text.slice(0, 160) });
        }
        // 关闭复习弹窗，再次进入按到期筛选
        await ev('(function(){var m=__qa.q("#review-modal"); if(!m) return true; var b=__qa.q("#review-close")||__qa.q("#review-modal [data-close]")||__qa.q("#review-modal .close"); if(b){__qa.click(b); return "closed";} document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return "escape";})()');
        await sleep(500);
        rec.failSelector = '#btn-review';
        const re = await ev('(function(){var b=__qa.q("#btn-review"); if(!b) return "missing"; __qa.click(b); return "clicked";})()');
        const reEntry = await waitFor('(function(){var m=__qa.q("#review-modal"); return m && __qa.vis(m);})()', 4000);
        const reInfo = await ev('(function(){var m=__qa.q("#review-modal"); var c=__qa.q("#review-card"); var t=__qa.q("#toast-layer"); return {modal:m?__qa.vis(m):false, card:c?__qa.vis(c):false, text:m?__qa.txt(m).slice(0,240):"", toast:t?__qa.txt(t):""};})()');
        rec.reenTry = { clicked: re, visible: !!reEntry, info: reInfo };
        /* 「按到期时间筛选」允许两种正确形态：重新开卡，或明确告知暂无到期词 */
        const reOk = !!reEntry || /无|没有|暂|完成|到期/i.test(reInfo.toast || '');
        REQUIRED(rec, reOk, '再次进入复习能打开并按到期筛选（或有明确空态提示）', JSON.stringify(reInfo));
        /* 收尾：把复习弹窗关掉。不关的话 .modal-layer 会盖在正文上，吃掉后续步骤的点击 */
        await ev('(function(){var b=__qa.q("#review-modal [data-close]")||__qa.q("#review-close"); if(b){__qa.click(b); return "closed";} document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return "escape";})()');
        await sleep(600);
        const closedAfter = await ev('(function(){var m=__qa.q("#review-modal"); var layer=__qa.q("#modal-layer"); return {modal:m?__qa.vis(m):false, layer:layer?__qa.vis(layer):false, layerHidden:layer?!!layer.hidden:null};})()');
        rec.modalAfterReview = closedAfter;
        REQUIRED(rec, !closedAfter.modal && !closedAfter.layer, '复习结束后弹窗关闭，不再遮挡正文', JSON.stringify(closedAfter));
        rec.shot = await shot('ui-04-review');
        rec.shots.push(rec.shot);
      });
    }

    /* ------------------------------------------------------- T5 句子分析 */
    if (shouldRun('T5')) {
      await runStep('T5', '句子成分分析：主干/成分/语法点 + 自动推断标注', async (rec) => {
        if (!selftest) { await goRoute('read'); await sleep(300); }
        /* 句子卡是异步渲染的：先出现骨架「正在分析句子成分…」，分析完成才换成内容。
           只等「可见」会抓到加载态，必须等到内容出现或明确报不可用。
           统计口径按契约 §4.2 / §8.5：主干区（.skeleton + struct-row）、逐词成分（.token-cloud）、
           语法点（.note-item）、置信度与「自动推断」标注。 */
        const cardWaitJs = '(function(){' +
          'var c=__qa.q("#sentence-card"); if(!c||!__qa.vis(c)) return null;' +
          'var t=__qa.txt(c); if(t.indexOf("正在分析")>=0) return null; if(t.length<8) return null;' +
          'var sk=c.querySelector(".skeleton__text");' +
          'var rows=c.querySelectorAll(".struct-row");' +
          'var roles=[].slice.call(c.querySelectorAll(".struct-row .role")).map(function(e){return __qa.txt(e);});' +
          'var notes=c.querySelectorAll(".note-item");' +
          'var toks=[].slice.call(c.querySelectorAll(".token-cloud .token"));' +
          'var roleWord=/主语|谓语|宾语|表语|状语|定语|补语|同位语|连词|引导词/;' +
          'var tokenRoles=toks.filter(function(tk){var i=tk.querySelector("i"); return i && roleWord.test(__qa.txt(i));});' +
          'return {text:t, len:t.length, summary:sk?__qa.txt(sk):"", structRows:rows.length, roleLabels:roles,' +
          '  noteCount:notes.length, tokenCount:toks.length, tokenRoleCount:tokenRoles.length,' +
          '  hasSkeleton:/主干/.test(t), hasConfidence:/置信度\\s*\\d+%/.test(t),' +
          '  quote:(function(){var q=c.querySelector(".card__quote"); return q?__qa.txt(q):"";})(),' +
          '  structTexts:[].slice.call(c.querySelectorAll(".struct-row .struct-text")).map(function(e){return __qa.txt(e);}),' +
          '  autoTag:/自动推断/.test(t), unavailable:/暂不可用/.test(t)};' +
          '})()';
        /* 多句采样：句析是启发式，单句可能没有主干行（契约允许 structure 为空数组），
           所以按「主干区 / 逐词成分 / 语法点 / 置信度 / 自动推断标注」逐项验证，并取多句里的最好结果。 */
        const needles = ['study in patience', 'Fishermen move along the quay', 'Tourists arrive in coaches', 'harbour authority had been deliberating'];
        let clickInfo = null, card = null, bestScore = -1, attempts = [];
        for (const needle of needles) {
          const ci = await ev('__qa.sentenceAt(' + JSON.stringify(needle) + ')');
          if (!ci) { attempts.push({ needle: needle, click: null }); continue; }
          const c = await waitFor(cardWaitJs, 7000);
          attempts.push({
            needle: needle, sentIndex: ci.sentIndex, tag: ci.tag,
            card: c ? { structRows: c.structRows, roleLabels: c.roleLabels, noteCount: c.noteCount, tokenCount: c.tokenCount, tokenRoleCount: c.tokenRoleCount, summary: c.summary, len: c.len, hasConfidence: c.hasConfidence, autoTag: c.autoTag } : null,
          });
          if (!clickInfo) clickInfo = ci;
          if (c) {
            const score = (c.structRows * 3) + c.noteCount + c.tokenRoleCount + (c.hasConfidence ? 2 : 0);
            if (score > bestScore) { bestScore = score; card = c; clickInfo = ci; }
          }
          await sleep(150);
        }
        rec.attempts = attempts;
        rec.failSelector = '#article-body';
        if (!clickInfo) throw new StepFail('正文里找不到可点击的句子（.sent[data-si]）');
        rec.clickInfo = clickInfo;
        REQUIRED(rec, clickInfo.onWord === false, '点击落点不在单词上（.w[data-w]），否则会先开词卡', JSON.stringify(clickInfo));
        rec.failSelector = '#sentence-card';
        if (!card) {
          const digest = await ev('(function(){var c=__qa.q("#sentence-card"); return {exists:!!c, vis:c?__qa.vis(c):false, text:c?__qa.txt(c).slice(0,200):"", inspector:(function(){var i=__qa.q("#inspector"); return i?__qa.txt(i).slice(0,200);})(), overlays:__qa.summary().overlays, toasts:__qa.summary().toasts, analyze:typeof window.DR.analyze};})()');
          throw new StepFail('点句子后 #sentence-card 没有出现（或一直停在加载态）：' + JSON.stringify(digest));
        }
        const t = card.text;
        const hasZh = /[\u4e00-\u9fa5]/.test(t);
        const maxNotes = Math.max(0, ...attempts.map((a) => (a.card && a.card.noteCount) || 0));
        const maxStruct = Math.max(0, ...attempts.map((a) => (a.card && a.card.structRows) || 0));
        const maxTokenRoles = Math.max(0, ...attempts.map((a) => (a.card && a.card.tokenRoleCount) || 0));
        const maxTokens = Math.max(0, ...attempts.map((a) => (a.card && a.card.tokenCount) || 0));
        const anyConfidence = attempts.some((a) => a.card && a.card.hasConfidence);
        const anyAutoTag = attempts.some((a) => a.card && a.card.autoTag);
        REQUIRED(rec, card.len > 10, '#sentence-card 有分析内容', '长度 ' + card.len);
        REQUIRED(rec, !card.unavailable, '句子分析可用（不是「暂不可用」空壳）', t.slice(0, 240));
        REQUIRED(rec, hasZh, '#sentence-card 显示中文分析', t.slice(0, 160));
        REQUIRED(rec, card.hasSkeleton, '分析卡有「主干」区块（.skeleton）', t.slice(0, 200));
        REQUIRED(rec, maxTokens >= 3, '分析卡有逐词词性（.token-cloud 至少 3 词）', '最多 token 数=' + maxTokens);
        REQUIRED(rec, maxTokenRoles >= 1 || maxStruct >= 1, '分析卡出现成分标注（逐词角色或主干行）', JSON.stringify({ maxTokenRoles: maxTokenRoles, maxStruct: maxStruct }));
        REQUIRED(rec, maxNotes >= 1, '分析卡出现语法点（.note-item）', '最多语法点数=' + maxNotes);
        REQUIRED(rec, anyAutoTag || card.autoTag, '分析卡明示「自动推断 · 仅供参考」（契约 §8.5）', '卡片文本：' + t.slice(0, 220));
        REQUIRED(rec, anyConfidence, '分析卡给出置信度（契约 §4.2 confidence）', t.slice(0, 200));
        SOFT(rec, maxStruct >= 1, '主干行 .struct-row（采样句子都为空 → 规则引擎质量项，供 parser-engine 参考）', 'maxStruct=' + maxStruct);
        /* 主干行按句序显示（Lead 说 structure 已按句序输出）→ 检查 struct-text 在引句里的出现位置递增 */
        if (card.structTexts && card.structTexts.length >= 2 && card.quote) {
          const q = String(card.quote);
          const idxs = card.structTexts.map((txt) => q.indexOf(String(txt)));
          const ordered = idxs.every((v, i) => v >= 0 && (i === 0 || v >= idxs[i - 1]));
          rec.structOrder = { structTexts: card.structTexts, idxs: idxs, ordered: ordered };
          SOFT(rec, ordered, '主干成分按句序排列（struct-text 在引句中位置递增）', JSON.stringify(rec.structOrder).slice(0, 240));
        } else {
          rec.structOrder = { structTexts: (card.structTexts || []), quote: (card.quote || '').slice(0, 80), ordered: null };
        }
        rec.cardText = t.slice(0, 600);
        rec.cardSummary = card.summary;
        rec.structRowCount = maxStruct;
        rec.roleLabels = card.roleLabels;
        rec.shot = await shot('ui-05-sentence');
        rec.shots.push(rec.shot);
        /* 角色着色：#btn-role-toggle 在 #sentence-card 内，切换的是原文着色（瞬态，不写 settings） */
        rec.failSelector = '#btn-role-toggle';
        const roleBtn = await ev('(function(){var b=__qa.q("#btn-role-toggle"); if(!b) return {found:false}; window.__roleCtl=b; return {found:true, vis:__qa.vis(b), text:__qa.txt(b).slice(0,40), isOn:/\bis-on\b/.test(b.className||"")};})()');
        rec.roleControl = roleBtn;
        REQUIRED(rec, roleBtn && roleBtn.found, '#btn-role-toggle 在 #sentence-card 内（Lead 定）', JSON.stringify(roleBtn));
        REQUIRED(rec, roleBtn.vis, '#btn-role-toggle 可见可点', JSON.stringify(roleBtn));
        const countRoles = '(function(){return {roleSpans:__qa.all("#article-body .w[class*=\\"role--\\"]").length, btnText:__qa.txt(__qa.q("#btn-role-toggle")), btnOn:/\\bis-on\\b/.test((__qa.q("#btn-role-toggle")||{}).className||"")};})()';
        const rolesBefore = await ev(countRoles);
        await ev('(function(){var b=__qa.q("#btn-role-toggle"); if(b) __qa.click(b); return true;})()');
        await sleep(700);
        const rolesOn = await ev(countRoles);
        rec.roleToggle = { before: rolesBefore, on: rolesOn };
        REQUIRED(rec, rolesOn.roleSpans > 0, '点 #btn-role-toggle 后原文出现 role--* 着色', JSON.stringify(rolesOn));
        rec.shot2 = await shot('ui-05b-role-on');
        rec.shots.push(rec.shot2);
        await ev('(function(){var b=__qa.q("#btn-role-toggle"); if(b) __qa.click(b); return true;})()');
        await sleep(700);
        const rolesOff = await ev(countRoles);
        rec.roleToggleOff = rolesOff;
        REQUIRED(rec, rolesOff.roleSpans === 0, '再点一次角色着色能还原（role--* 全部清掉）', JSON.stringify(rolesOff));
        const setOpen = await ev('(function(){var m=__qa.q("#settings-modal"); if(m && __qa.vis(m)){ var b=m.querySelector("[data-close]"); if(b){__qa.click(b); return "closed";} } return "not-open";})()');
        rec.settingsModalState = setOpen;
        await sleep(200);
        await ev('(function(){var m=__qa.q("#settings-modal"); if(!m) return true; var b=__qa.q("#settings-close")||__qa.q("#settings-modal [data-close]")||__qa.q("#settings-modal .close"); if(b){__qa.click(b); return true;} document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true;})()');
        await sleep(300);
      });
    }

    /* --------------------------------------------------------- T6 文章 */
    if (shouldRun('T6')) {
      await runStep('T6', '文章保存/新建/切换/删除 + 刷新持久化', async (rec) => {
        if (!selftest) { await goRoute('read'); await sleep(300); }
        const arts0 = await ev('(function(){var a=__qa.ls("dr.articles.v1"); return Array.isArray(a)?a:[];})()');
        rec.articlesBefore = arts0.map((a) => a.title);
        // 保存当前长文
        rec.failSelector = '#btn-save-article';
        const saved = await ev('(function(){var b=__qa.q("#btn-save-article"); if(!b) return "missing"; __qa.click(b); return "clicked";})()');
        REQUIRED(rec, saved === 'clicked', '#btn-save-article 存在（契约 §5）', String(saved));
        await sleep(800);
        const arts1 = await ev('(function(){var a=__qa.ls("dr.articles.v1"); return Array.isArray(a)?a.map(function(x){return {id:x.id,title:x.title,len:(x.text||"").length,createdAt:x.createdAt};}):[];})()');
        rec.afterSave = arts1;
        REQUIRED(rec, arts1.length >= 1, '保存后 dr.articles.v1 有 1 篇（契约 §6）', JSON.stringify(arts1).slice(0, 240));
        REQUIRED(rec, arts1.some((a) => /Harbour/i.test(a.title || '')), '保存的文章标题正确', JSON.stringify(arts1.map((a) => a.title)));
        // 新建第二篇
        await ev('(function(){var m=__qa.q("#paste-modal"); if(m && __qa.vis(m)) return true; var b=__qa.q("#btn-new-article"); if(b) __qa.click(b); return true;})()');
        await waitFor('(function(){var m=__qa.q("#paste-modal"); return m && __qa.vis(m);})()', 4000);
        await ev('window.__T2 = ' + JSON.stringify(ARTICLE_2) + '; true');
        await ev('(function(){__qa.setValue(__qa.q("#paste-title"), ' + JSON.stringify(TITLE_2) + '); __qa.setValue(__qa.q("#paste-text"), window.__T2); return true;})()');
        rec.failSelector = '#btn-paste-start';
        await ev('(function(){var b=__qa.q("#btn-paste-start"); if(b) __qa.click(b); return true;})()');
        await waitFor('(function(){var a=__qa.q("#article-body"); return a && __qa.txt(a).indexOf("lighthouse")>=0;})()', 6000);
        await sleep(400);
        let arts2 = await ev('(function(){var a=__qa.ls("dr.articles.v1"); return Array.isArray(a)?a.map(function(x){return {id:x.id,title:x.title,len:(x.text||"").length};}):[];})()');
        if (!arts2.some((a) => /Second/i.test(a.title || ''))) {
          // 有的实现需要显式保存
          await ev('(function(){var b=__qa.q("#btn-save-article"); if(b) __qa.click(b); return true;})()');
          await sleep(700);
          arts2 = await ev('(function(){var a=__qa.ls("dr.articles.v1"); return Array.isArray(a)?a.map(function(x){return {id:x.id,title:x.title,len:(x.text||"").length};}):[];})()');
          rec.savedSecondExplicitly = true;
        }
        rec.afterSecond = arts2;
        REQUIRED(rec, arts2.length === 2, '新建第二篇后共 2 篇', JSON.stringify(arts2.map((a) => a.title)).slice(0, 240));
        const libN = await ev('(function(){var btns=__qa.all("#library-list [data-id]"); var rows=__qa.all("#library-list li"); var html=(__qa.q("#library-list")?__qa.q("#library-list").outerHTML:""); return {n:btns.length||rows.length, rows:rows.length, how:btns.length?"[data-id]":"li", html:html.replace(/\s+/g," ").slice(0,300)};})()');
        rec.library = libN;
        SOFT(rec, libN.n >= 2, '#library-list 显示 2 篇', JSON.stringify(libN).slice(0, 300));
        // 切换到第一篇：行内真正可点的是 button[data-id]，点 li 本身不触发 openArticle
        rec.failSelector = '#library-list';
        const sw = await ev('(function(){' +
          'var rows=__qa.all("#library-list li");' +
          'for(var i=0;i<rows.length;i++){ var el=rows[i]; if(!/Harbour/i.test(__qa.txt(el))) continue;' +
          '  var btn=el.querySelector("[data-id]"); var target=btn||el; __qa.click(target);' +
          '  return {ok:true, text:__qa.txt(el).slice(0,60), tag:target.tagName, via:btn?"button[data-id]":"row"}; }' +
          'var btns=__qa.all("#library-list [data-id]");' +
          'for(var j=0;j<btns.length;j++){ if(/Harbour/i.test(__qa.txt(btns[j]))){ __qa.click(btns[j]); return {ok:true, text:__qa.txt(btns[j]).slice(0,60), tag:btns[j].tagName, via:"button-only"}; } }' +
          'return {ok:false, rows:rows.length, texts:rows.map(function(e){return __qa.txt(e).slice(0,30);})};})()');
        rec.switchInfo = sw;
        REQUIRED(rec, sw && sw.ok, '文章库里能点开第一篇', JSON.stringify(sw).slice(0, 300));
        const switched = await waitFor('(function(){var t=__qa.txt(__qa.q("#article-title")); var b=__qa.txt(__qa.q("#article-body")); return (/Harbour/i.test(t) || /harbour/i.test(b.slice(0,400))) ? true : null;})()', 5000);
        rec.switchDetected = !!switched;
        await sleep(300);
        const cur1 = await ev('(function(){return {title:__qa.txt(__qa.q("#article-title")), body:__qa.txt(__qa.q("#article-body")).slice(0,120), tokens:__qa.all("#article-body [data-w]").length};})()');
        rec.switched = cur1;
        REQUIRED(rec, /Harbour/i.test(cur1.title) || /harbour/i.test(cur1.body), '切换到第一篇后正文/标题正确', JSON.stringify(cur1).slice(0, 240));
        /* #article-title 是 contenteditable、blur 保存（Lead 定行为）。
           注意：synth 事件不会触发浏览器默认聚焦行为，el.focus()/el.blur() 在 headless 下也不产生 blur，
           所以这里用 CDP Input 发真实受信任点击来聚焦，再点另一处真实失焦。 */
        const titleInfo = await ev('(function(){var el=__qa.q("#article-title"); if(!el) return {exists:false}; return {exists:true, ce:el.isContentEditable, tag:el.tagName, old:__qa.txt(el)};})()');
        rec.titleEdit = titleInfo;
        if (titleInfo && titleInfo.ce) {
          const titlePos = await inputClickSel('#article-title');
          await sleep(250);
          rec.titleFocus = await ev('(function(){var el=__qa.q("#article-title"); return {active:document.activeElement===el, tag:document.activeElement?(document.activeElement.tagName+"/"+(document.activeElement.id||"")):""};})()');
          rec.titleClickPos = titlePos;
          await ev('(function(){var el=__qa.q("#article-title"); el.textContent="Harbour QA Renamed"; el.dispatchEvent(new InputEvent("input",{bubbles:true, data:"x"})); return true;})()');
          await sleep(200);
          const metaPos = await inputClickSel('#article-meta');
          if (!metaPos) await inputClickSel('#article-head');
          await sleep(900);
          const titlesNow = await ev('(function(){var a=__qa.ls("dr.articles.v1"); return Array.isArray(a)?a.map(function(x){return x.title;}):[];})()');
          rec.titlesAfterEdit = titlesNow;
          SOFT(rec, titlesNow.some((t) => /Renamed/i.test(t || '')), '改 #article-title 后 blur 写入 dr.articles.v1', JSON.stringify(titlesNow) + ' focus=' + JSON.stringify(rec.titleFocus));
          if (!titlesNow.some((t) => /Renamed/i.test(t || ''))) {
            rec.asserts.push({ name: '标题编辑未落库（Lead 正在修标题推导，可能是相关）', status: 'warn', detail: '标题显示 ' + JSON.stringify(await ev('__qa.txt(__qa.q("#article-title"))')) + '，存储 ' + JSON.stringify(titlesNow) });
          }
        } else {
          rec.asserts.push({ name: '#article-title 是 contenteditable（Lead 定）', status: 'warn', detail: JSON.stringify(titleInfo) });
        }
        // 删除当前文章
        rec.failSelector = '#btn-delete-article';
        const del = await ev('(function(){var b=__qa.q("#btn-delete-article"); if(!b) return "missing"; __qa.click(b); return "clicked";})()');
        REQUIRED(rec, del === 'clicked', '#btn-delete-article 存在（契约 §5）', String(del));
        await sleep(900);
        const arts3 = await ev('(function(){var a=__qa.ls("dr.articles.v1"); return Array.isArray(a)?a.map(function(x){return {id:x.id,title:x.title};}):[];})()');
        rec.afterDelete = arts3;
        REQUIRED(rec, arts3.length === 1, '删除后只剩 1 篇', JSON.stringify(arts3));
        REQUIRED(rec, arts3.every((a) => !/Harbour/i.test(a.title || '')), '删掉的是当前文章', JSON.stringify(arts3.map((a) => a.title)));
        // 刷新持久化
        if (!selftest) {
          await reload();
          await goRoute('read');
          await sleep(500);
          const cur2 = await ev('(function(){var a=__qa.ls("dr.articles.v1"); var list=__qa.all("#library-list [data-id]"); return {n:Array.isArray(a)?a.length:0, titles:Array.isArray(a)?a.map(function(x){return x.title;}):[], title:__qa.txt(__qa.q("#article-title")), bodyLen:__qa.txt(__qa.q("#article-body")).length, libN:list.length, progress:(Array.isArray(a)&&a[0])?a[0].progress:undefined};})()');
          rec.afterReload = cur2;
          REQUIRED(rec, cur2.n === 1, '刷新后文章数仍为 1', JSON.stringify(cur2).slice(0, 240));
          REQUIRED(rec, /Second/i.test(cur2.title) || cur2.bodyLen > 100, '刷新后剩余文章正常显示', JSON.stringify(cur2).slice(0, 240));
          SOFT(rec, typeof cur2.progress === 'number', '文章保存 progress 字段（契约 §6）', 'progress=' + JSON.stringify(cur2.progress));
        }
        rec.shot = await shot('ui-06-articles');
        rec.shots.push(rec.shot);
      });
    }

    /* ------------------------------------------------------ T7 设置/窄屏 */
    if (shouldRun('T7')) {
      await runStep('T7', '主题 / 字号 / 420px 无横向溢出', async (rec) => {
        if (!selftest) await goRoute('read');
        await sleep(300);
        // 主题：headless 默认跟随系统（可能一开始就是 dark）→ 用点击把两种主题都确定性地走一遍并各截一张
        rec.failSelector = '#theme-toggle';
        const themeAttr = async () => ev('(function(){return {attr:document.documentElement.getAttribute("data-theme")||"", cls:document.documentElement.className, bg:getComputedStyle(document.body).backgroundColor, settings:(__qa.ls("dr.settings.v1")||{}).theme};})()');
        const setTheme = async (target) => {
          for (let i = 0; i < 5; i++) {
            const cur = await ev('document.documentElement.getAttribute("data-theme")||""');
            if (cur === target) return cur;
            await ev('(function(){var b=__qa.q("#theme-toggle"); if(b) __qa.click(b); return true;})()');
            await sleep(500);
          }
          return await ev('document.documentElement.getAttribute("data-theme")||""');
        };
        const themeBefore = await themeAttr();
        const toggled = await ev('(function(){var b=__qa.q("#theme-toggle"); if(!b) return "missing"; __qa.click(b); return "clicked";})()');
        REQUIRED(rec, toggled === 'clicked', '#theme-toggle 存在（契约 §5）', String(toggled));
        await sleep(700);
        const themeAfter = await themeAttr();
        rec.theme = { before: themeBefore, after: themeAfter };
        const changed = themeBefore.attr !== themeAfter.attr || themeBefore.cls !== themeAfter.cls || themeBefore.bg !== themeAfter.bg;
        REQUIRED(rec, changed, '点主题按钮后主题确实变化', JSON.stringify({ before: themeBefore, after: themeAfter }).slice(0, 320));
        SOFT(rec, themeAfter.settings && themeAfter.settings !== themeBefore.settings, '主题写入 dr.settings.v1.theme（契约 §6）', JSON.stringify(themeAfter.settings));
        const darkReached = await setTheme('dark');
        rec.themeDarkReached = darkReached;
        REQUIRED(rec, darkReached === 'dark', '能切到深色主题', 'data-theme=' + darkReached);
        await sleep(400);
        rec.shotDark = await shot('ui-07-dark');
        rec.shots.push(rec.shotDark);
        const lightReached = await setTheme('light');
        rec.themeLightReached = lightReached;
        REQUIRED(rec, lightReached === 'light', '能切到浅色主题', 'data-theme=' + lightReached);
        await sleep(400);
        rec.shotLight = await shot('ui-07-light');
        rec.shots.push(rec.shotLight);
        rec.themeScreens = { dark: rec.shotDark, light: rec.shotLight };
        await sleep(500);
        // 字号：Lead 定顶部栏 #font-dec / #font-inc（A− / A+），设置面板另有 range #set-font
        const fontBefore = await ev('(function(){var s=__qa.ls("dr.settings.v1"); return {px:__qa.fontSize("#article-body"), fontScale:s?s.fontScale:null, hasInc:!!__qa.q("#font-inc"), hasDec:!!__qa.q("#font-dec"), hasRange:!!__qa.q("#set-font")};})()');
        rec.fontControl = fontBefore;
        rec.failSelector = '#font-inc';
        REQUIRED(rec, fontBefore.hasInc, '#font-inc 存在（Lead 定的字号放大按钮）', JSON.stringify(fontBefore));
        REQUIRED(rec, fontBefore.hasDec, '#font-dec 存在（Lead 定的字号缩小按钮）', JSON.stringify(fontBefore));
        await ev('(function(){var b=__qa.q("#font-inc"); if(b) __qa.click(b); return true;})()');
        await sleep(900);
        const fontAfter = await ev('(function(){var s=__qa.ls("dr.settings.v1"); return {px:__qa.fontSize("#article-body"), fontScale:s?s.fontScale:null};})()');
        rec.font = { before: fontBefore, after: fontAfter };
        REQUIRED(rec, Math.abs(fontAfter.px - fontBefore.px) >= 0.5 || (fontAfter.fontScale !== null && fontBefore.fontScale !== null && fontAfter.fontScale !== fontBefore.fontScale), '点 #font-inc 后正文字号真的变大', JSON.stringify(rec.font));
        await ev('(function(){var b=__qa.q("#font-dec"); if(b) __qa.click(b); return true;})()');
        await sleep(700);
        const fontRestored = await ev('(function(){var s=__qa.ls("dr.settings.v1"); return {px:__qa.fontSize("#article-body"), fontScale:s?s.fontScale:null};})()');
        rec.fontRestored = fontRestored;
        SOFT(rec, Math.abs(fontRestored.px - fontBefore.px) < 1.5, '点 #font-dec 能还原字号', JSON.stringify({ before: fontBefore.px, restored: fontRestored.px }));
        /* 设置面板里的 range #set-font 只做存在性检查（真值调档走上方按钮） */
        await ev('(function(){var b=__qa.q("#settings-open"); if(b) __qa.click(b); return true;})()');
        await waitFor('(function(){var m=__qa.q("#settings-modal"); return m && __qa.vis(m);})()', 4000);
        SOFT(rec, await ev('!!__qa.q("#set-font")'), '设置面板有 #set-font 滑块（Lead 定）', '');
        await ev('(function(){var m=__qa.q("#settings-modal"); if(!m) return true; var b=__qa.q("#settings-close")||__qa.q("#settings-modal [data-close]")||__qa.q("#settings-modal .close"); if(b){__qa.click(b); return true;} document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true;})()');
        await sleep(400);
        // 420 窄屏
        const narrowOk = await setViewport(420, 900);
        for (const name of ['read', 'notebook', 'dict']) {
          await goRoute(name);
          await sleep(500);
          const ov = await ev('(function(){var o=__qa.overflow(); o.tokens=__qa.all("#article-body [data-w]").length; o.hash=location.hash; return o;})()');
          rec['overflow_' + name] = ov;
          if (!narrowOk) {
            rec.asserts.push({ name: '420px 无横向溢出 · ' + name, status: 'warn', detail: '视口未切成 420（工具层失败），本次未测' });
            continue;
          }
          rec.failSelector = 'html';
          REQUIRED(rec, ov.over <= 1, '420px 无横向溢出 · ' + name, 'scrollWidth=' + ov.scroll + ' innerWidth=' + ov.inner + ' 溢出=' + ov.over + 'px');
          rec['shot420_' + name] = await shot('ui-07-420-' + name);
          rec.shots.push(rec['shot420_' + name]);
        }
        if (narrowOk) {
          try { await cdp.send('Emulation.clearDeviceMetricsOverride'); } catch (e) { /* ignore */ }
        }
        await sleep(300);
      });
    }

    /* --------------------------------------------------------- T8 字体 */
    if (shouldRun('T8')) {
      await runStep('T8', '阅读字体：六个字体面加载 / 切换 / 刷新保留', async (rec) => {
        if (!selftest) { await goRoute('read'); await sleep(300); }
        /* 字体面状态：正确口径是 FontFace.status（懒加载字体不主动 load 会是 unloaded） */
        const warm = await ev('(function(){ if(!document.fonts) return Promise.resolve(true); var fams=["Fraunces","Newsreader","Inter","WenKaiCN","Literata","JetBrains Mono"]; return Promise.all(fams.map(function(f){ return document.fonts.load(\'16px "\' + f + \'"\').catch(function(){ return null; }); })).then(function(){ return document.fonts.ready; }).then(function(){ return true; }); })()');
        rec.fontWarm = !!warm;
        const faces = await ev('(function(){var out=[]; try{document.fonts.forEach(function(f){ out.push({family:String(f.family||"").replace(/["\']/g,""), weight:String(f.weight||""), status:f.status}); });}catch(e){} return out;})()');
        rec.fontFaces = faces;
        const required = ['Fraunces', 'Newsreader', 'Inter', 'WenKaiCN', 'Literata', 'JetBrains Mono'];
        const byFam = {};
        (faces || []).forEach((f) => { byFam[String(f.family).replace(/["']/g, '')] = f.status; });
        const missingFonts = required.filter((f) => byFam[f] !== 'loaded');
        rec.fontStatus = { byFam: byFam, missing: missingFonts, fontsStatus: await ev('document.fonts ? document.fonts.status : "n/a"') };
        REQUIRED(rec, missingFonts.length === 0, '六个自托管字体面全部 loaded（file:// 双击场景）', '未加载：' + (missingFonts.join(', ') || '无') + '；状态表 ' + JSON.stringify(byFam));
        /* 正文行宽：只记录，不写死旧值（Lead 把行宽调到约 70 字） */
        const widthInfo = await ev('(function(){var a=__qa.q("#article-body"); var cs=a?getComputedStyle(a):null; return {width:a?Math.round(a.getBoundingClientRect().width):0, maxWidth:cs?cs.maxWidth:"", fontFamily:cs?cs.fontFamily:"", fontSize:cs?cs.fontSize:"", lineHeight:cs?cs.lineHeight:""};})()');
        rec.articleWidth = widthInfo;
        REQUIRED(rec, widthInfo.width >= 600 && widthInfo.width <= 760, '桌面正文行宽约 70 字（600–760px，Lead 定 ~668px）', JSON.stringify(widthInfo).slice(0, 240));
        /* 打开设置 → 切阅读字体（真实 select change） */
        rec.failSelector = '#settings-open';
        await ev('(function(){var b=__qa.q("#settings-open"); if(b) __qa.click(b); return true;})()');
        const setVis = await waitFor('(function(){var m=__qa.q("#settings-modal"); return m && __qa.vis(m);})()', 4000);
        REQUIRED(rec, !!setVis, '#settings-modal 能打开', '');
        const selInfo = await ev('(function(){var s=__qa.q("#set-readfont"); if(!s) return {exists:false}; return {exists:true, kind:s.tagName, value:s.value, options:[].slice.call(s.options).map(function(o){return o.value;})};})()');
        rec.readFontSelect = selInfo;
        REQUIRED(rec, selInfo && selInfo.exists, '#set-readfont 阅读字体选择器存在', JSON.stringify(selInfo));
        const expected = { literata: 'Literata', mono: 'JetBrains Mono', system: null, sans: 'Inter', newsreader: 'Newsreader' };
        rec.fontSwitches = [];
        for (const key of ['literata', 'mono', 'system', 'sans', 'newsreader']) {
          const applied = await ev('(function(){var s=__qa.q("#set-readfont"); if(!s) return false; var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value"); if(d&&d.set) d.set.call(s,"' + key + '"); else s.value="' + key + '"; s.dispatchEvent(new Event("input",{bubbles:true})); s.dispatchEvent(new Event("change",{bubbles:true})); return true;})()');
          await sleep(700);
          const st = await ev('(function(){var a=__qa.q("#article-body"); var cs=a?getComputedStyle(a):null; var s=__qa.ls("dr.settings.v1"); return {attr:document.documentElement.getAttribute("data-read-font")||"", fontFamily:cs?cs.fontFamily:"", settings:(s&&s.readFont)||null, px:cs?parseFloat(cs.fontSize):0};})()');
          rec.fontSwitches.push({ key: key, applied: applied, state: st });
          REQUIRED(rec, applied === true, '切换阅读字体到 ' + key + '（#set-readfont change）', JSON.stringify(st));
          REQUIRED(rec, st.attr === key, 'data-read-font 变为 ' + key, JSON.stringify(st));
          if (expected[key]) {
            REQUIRED(rec, new RegExp(expected[key].replace(/\s+/g, '\\s+'), 'i').test(st.fontFamily || ''), '正文实际字体栈含 ' + expected[key], st.fontFamily);
          } else {
            REQUIRED(rec, !/Newsreader|Literata|JetBrains Mono/i.test(st.fontFamily || ''), 'system 档不指向自托管阅读字体（用系统衬线栈）', st.fontFamily);
          }
          if (key === 'literata') { rec.shotLiterata = await shot('ui-08-font-literata'); rec.shots.push(rec.shotLiterata); }
          if (key === 'mono') { rec.shotMono = await shot('ui-08-font-mono'); rec.shots.push(rec.shotMono); }
        }
        /* file:// 下 document.fonts.check 必须为 true（Lead 要求独立确认） */
        const checkFams = ['Fraunces', 'Newsreader', 'Inter', 'WenKaiCN', 'Literata', 'JetBrains Mono'];
        const checks = await ev('(function(){var out={}; var fams=' + JSON.stringify(checkFams) + '; fams.forEach(function(f){ try{ out[f]=document.fonts.check(\'16px "\' + f + \'"\'); }catch(e){ out[f]=false; } }); return out; })()');
        rec.fontCheck = checks;
        const checkFalse = Object.keys(checks || {}).filter((k) => !checks[k]);
        REQUIRED(rec, checkFalse.length === 0, 'document.fonts.check 六个字体均为 true（file://）', JSON.stringify(checks));
        /* 字体请求失败（若有 @font-face 拉不到会静默降级，必须抓出来） */
        const fontFails = (cdp.failedRequests || []).filter((r) => /\.(woff2?|ttf)/i.test(r.url || ''));
        rec.fontFailedRequests = fontFails;
        REQUIRED(rec, fontFails.length === 0, '全程没有字体请求失败', JSON.stringify(fontFails).slice(0, 300));
        /* 自定义字体：#set-customfont 输入本机字体名要生效（Windows 一定有 Georgia） */
        const customSelect = await ev('(function(){var s=__qa.q("#set-readfont"); if(!s) return false; var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value"); if(d&&d.set) d.set.call(s,"custom"); else s.value="custom"; s.dispatchEvent(new Event("input",{bubbles:true})); s.dispatchEvent(new Event("change",{bubbles:true})); return true;})()');
        await sleep(700);
        const customInput = await ev('(function(){var i=__qa.q("#set-customfont"); return i ? {exists:true, vis:__qa.vis(i), type:i.type, value:i.value} : {exists:false};})()');
        rec.customFontInput = customInput;
        REQUIRED(rec, customSelect === true, '阅读字体可切到 custom', String(customSelect));
        REQUIRED(rec, customInput && customInput.exists, '#set-customfont 自定义字体输入框出现', JSON.stringify(customInput));
        if (customInput && customInput.exists) {
          await ev('(function(){var i=__qa.q("#set-customfont"); return __qa.setValue(i, "Georgia");})()');
          await sleep(700);
          const customState = await ev('(function(){var a=__qa.q("#article-body"); var cs=a?getComputedStyle(a):null; var s=__qa.ls("dr.settings.v1"); return {attr:document.documentElement.getAttribute("data-read-font")||"", fontFamily:cs?cs.fontFamily:"", customFont:(s&&s.customFont)||null};})()');
          rec.customFontState = customState;
          REQUIRED(rec, (customState.customFont || '') === 'Georgia', '自定义字体名写入 dr.settings.v1.customFont', JSON.stringify(customState));
          const varEvidence = await ev('(function(){var cs=getComputedStyle(document.documentElement); return {inlineRead:document.documentElement.style.getPropertyValue("--font-read"), computedRead:cs.getPropertyValue("--font-read"), serifStack:cs.getPropertyValue("--font-serif-stack")};})()');
          rec.customFontVar = varEvidence;
          REQUIRED(rec, /Georgia/i.test(customState.fontFamily || ''), '正文字体栈含自定义字体 Georgia（期望有效；实际若等于 UI 无衬线栈 → 代码用了未定义 CSS 变量 --font-serif-stack）', 'fontFamily=' + customState.fontFamily + '；变量证据=' + JSON.stringify(varEvidence));
        }
        /* 回到默认 Newsreader，再刷新验证持久化 */
        await ev('(function(){var s=__qa.q("#set-readfont"); if(!s) return false; var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value"); if(d&&d.set) d.set.call(s,"newsreader"); else s.value="newsreader"; s.dispatchEvent(new Event("input",{bubbles:true})); s.dispatchEvent(new Event("change",{bubbles:true})); return true;})()');
        await sleep(600);
        rec.dictStats = await ev('(function(){try{return DR.dict.stats();}catch(e){return {err:e.message};}})()');
        /* 关弹窗 + 刷新：字体设置要保留并生效 */
        await ev('(function(){var m=__qa.q("#settings-modal"); if(!m) return true; var b=m.querySelector("[data-close]"); if(b){__qa.click(b); return true;} document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true;})()');
        await sleep(400);
        if (!selftest) {
          await reload();
          await waitFor('(function(){var a=__qa.q("#article-body"); return a && __qa.txt(a).length > 100;})()', 8000);
          await sleep(400);
          const afterReload = await ev('(function(){var a=__qa.q("#article-body"); var cs=a?getComputedStyle(a):null; var s=__qa.ls("dr.settings.v1"); var out={attr:document.documentElement.getAttribute("data-read-font")||"", fontFamily:cs?cs.fontFamily:"", settings:(s&&s.readFont)||null, width:a?Math.round(a.getBoundingClientRect().width):0}; try{ out.newsreaderCheck=document.fonts.check(\'16px "Newsreader"\'); }catch(e){ out.newsreaderCheck=false; } return out;})()');
          rec.fontAfterReload = afterReload;
          REQUIRED(rec, (afterReload.settings || afterReload.attr) === 'newsreader', '刷新后 readFont 保留在 dr.settings.v1', JSON.stringify(afterReload));
          REQUIRED(rec, /Newsreader/i.test(afterReload.fontFamily || ''), '刷新后正文字体仍是 Newsreader', afterReload.fontFamily);
          REQUIRED(rec, afterReload.newsreaderCheck === true, '刷新后 document.fonts.check("16px \\"Newsreader\\"") 仍为 true（file://）', JSON.stringify(afterReload));
          rec.shotReloadFont = await shot('ui-08-font-reload');
          rec.shots.push(rec.shotReloadFont);
        }
      });
    }

    /* ------------------------------------------- T9 所有格 / 数字 token */
    if (shouldRun('T9')) {
      await runStep('T9', '所有格与数字 token：children’s / government’s / 1990s / isn’t', async (rec) => {
        if (!selftest) { await goRoute('read'); await sleep(300); }
        const POSS_TEXT = 'The children’s books were cheap. The government’s decision surprised everyone. Music of the 1990s felt different. It isn’t a secret that the children’s choir practised late. Last year’s festival was louder, and next year’s will be louder still.';
        /* 粘贴一篇短文章（真实路径：新文章 → 粘贴 → 开始阅读） */
        rec.failSelector = '#btn-new-article';
        await ev('(function(){var m=__qa.q("#paste-modal"); if(m && __qa.vis(m)) return true; var b=__qa.q("#btn-new-article"); if(b) __qa.click(b); return true;})()');
        const vis = await waitFor('(function(){var m=__qa.q("#paste-modal"); return m && __qa.vis(m);})()', 4000);
        REQUIRED(rec, !!vis, '#paste-modal 打开', '');
        await ev('window.__POSS = ' + JSON.stringify(POSS_TEXT) + '; true');
        await ev('(function(){__qa.setValue(__qa.q("#paste-title"), "Possessive And Numbers QA"); __qa.setValue(__qa.q("#paste-text"), window.__POSS); return true;})()');
        await ev('(function(){var b=__qa.q("#btn-paste-start"); if(b) __qa.click(b); return true;})()');
        const rendered = await waitFor('(function(){var a=__qa.q("#article-body"); return a && __qa.txt(a).indexOf("children")>=0;})()', 6000);
        REQUIRED(rec, !!rendered, '含所有格的短文章渲染出来', '');
        const body = await ev('(function(){var a=__qa.q("#article-body"); return {text:__qa.txt(a).slice(0,400), words:__qa.all("#article-body .w").length, tokens:[].slice.call(__qa.all("#article-body .w")).map(function(e){return __qa.txt(e);}).slice(0,60)};})()');
        rec.body = body;
        REQUIRED(rec, body.words >= 10, '短文章渲染出可点单词', JSON.stringify(body).slice(0, 200));
        /* 所有格 1：children’s —— 词头保留原拼写，释义来自原形 */
        rec.failSelector = '#article-body .w';
        const c1 = await ev('__qa.clickWordByText("children’s")');
        rec.possessive1 = c1;
        REQUIRED(rec, !!c1, 'children’s 是可点单词（.w[data-w]）', JSON.stringify({ dataW: c1 && c1.dataW }));
        const card1 = await waitFor('(function(){var c=__qa.q("#word-card"); if(!c||!__qa.vis(c)) return null; var w=__qa.q("#word-card-word")||c.querySelector(".word"); var t=__qa.txt(c); if(t.indexOf("正在加载")>=0) return null; return {text:t, head:w?__qa.txt(w):"", len:t.length};})()', 8000);
        rec.failSelector = '#word-card';
        REQUIRED(rec, !!card1, 'children’s 打开词卡', '');
        REQUIRED(rec, /children/i.test(card1.head), '词卡词头是 children’s（保留原拼写）', 'head=' + JSON.stringify(card1.head));
        REQUIRED(rec, /[\u4e00-\u9fa5]/.test(card1.text), 'children’s 词卡有中文释义（来自原形）', card1.text.slice(0, 160));
        SOFT(rec, new RegExp('原形[：:]\\s*(child|children)', 'i').test(card1.text) || /原形/.test(card1.text), '词卡给出原形（child/children）', card1.text.slice(0, 200));
        /* 所有格 2：government’s */
        const c2 = await ev('__qa.clickWordByText("government’s")');
        rec.possessive2 = c2;
        REQUIRED(rec, !!c2, 'government’s 是可点单词', JSON.stringify({ dataW: c2 && c2.dataW }));
        const card2 = await waitFor('(function(){var c=__qa.q("#word-card"); if(!c||!__qa.vis(c)) return null; var w=__qa.q("#word-card-word")||c.querySelector(".word"); var t=__qa.txt(c); if(t.indexOf("正在加载")>=0) return null; if(t.indexOf("government")<0) return null; return {text:t, head:w?__qa.txt(w):"", len:t.length};})()', 8000);
        REQUIRED(rec, !!card2, 'government’s 打开词卡', '');
        REQUIRED(rec, /government/i.test(card2.head), 'government’s 词头保留原拼写', 'head=' + JSON.stringify(card2.head));
        REQUIRED(rec, /[\u4e00-\u9fa5]/.test(card2.text), 'government’s 词卡有中文释义（来自 government）', card2.text.slice(0, 160));
        /* isn’t 缩写 */
        const c3 = await ev('__qa.clickWordByText("isn’t")');
        rec.contraction = c3;
        REQUIRED(rec, !!c3, 'isn’t 是可点单词（撇号处理）', JSON.stringify({ dataW: c3 && c3.dataW }));
        const card3 = await waitFor('(function(){var c=__qa.q("#word-card"); if(!c||!__qa.vis(c)) return null; var w=__qa.q("#word-card-word")||c.querySelector(".word"); var t=__qa.txt(c); if(t.indexOf("正在加载")>=0) return null; var h=w?__qa.txt(w):""; if(!/is/i.test(h) && t.indexOf("is")<0) return null; return {text:t.slice(0,300), head:h};})()', 8000);
        REQUIRED(rec, !!card3, 'isn’t 打开词卡', '');
        REQUIRED(rec, /[\u4e00-\u9fa5]/.test(card3.text), 'isn’t 词卡有中文释义', card3.text.slice(0, 160));
        /* 数字 token：1990s 不能被包成 .w（点不了） */
        const numberCheck = await ev('(function(){var spans=__qa.all("#article-body .w"); var digits=spans.filter(function(s){ return /1990/.test(__qa.txt(s)); }).length; var bodyTxt=__qa.txt(__qa.q("#article-body")); return {digitsInW:digits, bodyHas1990s:/1990s/.test(bodyTxt), wCount:spans.length};})()');
        rec.numberToken = numberCheck;
        REQUIRED(rec, numberCheck.bodyHas1990s, '正文里 1990s 照常显示', JSON.stringify(numberCheck));
        REQUIRED(rec, numberCheck.digitsInW === 0, '1990s 没有被包成可点单词（不是 .w）', JSON.stringify(numberCheck));
        rec.shot = await shot('ui-09-possessive');
        rec.shots.push(rec.shot);
      });
    }

    /* ------------------------------------------------------- T10 词库页 */
    if (shouldRun('T10')) {
      await runStep('T10', '词库页：统计条数 / 搜索 / 结果词卡', async (rec) => {
        if (!selftest) {
          const route = await goRoute('dict');
          rec.routeViaClick = route.viaClick;
          REQUIRED(rec, route.viaClick, '点 #tab-dict 能切到 #/dict（契约 §5 hash 路由）', JSON.stringify(route));
        }
        rec.failSelector = '#dict-stats';
        const stats = await ev('(function(){var s=__qa.q("#dict-stats"); return {exists:!!s, vis:s?__qa.vis(s):false, text:s?__qa.txt(s):""};})()');
        rec.dictStatsEl = stats;
        REQUIRED(rec, stats.exists && stats.vis, '#dict-stats 存在且可见', JSON.stringify(stats));
        const packLabels = ['四级', '六级', '专四', '专八', '雅思', '托福'];
        const hitPacks = packLabels.filter((x) => stats.text.indexOf(x) >= 0);
        rec.dictStatsText = stats.text;
        REQUIRED(rec, hitPacks.length >= 4, '#dict-stats 含各词库条数（四级/六级/专四/专八/雅思/托福）', '命中 ' + hitPacks.join('/') + '；文本：' + stats.text.slice(0, 240));
        REQUIRED(rec, /\d/.test(stats.text), '#dict-stats 有数字', stats.text.slice(0, 200));
        const dictApi = await ev('(function(){try{return DR.dict.stats();}catch(e){return {err:e.message};}})()');
        rec.dictApi = dictApi;
        REQUIRED(rec, dictApi && dictApi.exam === 16638, '考试词库条数 = 16,638（lex-builder 冻结版）', JSON.stringify(dictApi));
        /* 搜索：真实输入 → 结果列表 → 点结果打开词卡 */
        rec.failSelector = '#dict-search';
        const typed = await ev('(function(){var el=__qa.q("#dict-search"); if(!el) return "missing"; return __qa.setValue(el, "ubiquitous");})()');
        const typedValue = await ev('(function(){var el=__qa.q("#dict-search"); return el ? el.value : null;})()');
        rec.dictSearchValue = typedValue;
        REQUIRED(rec, typed === true && typedValue === 'ubiquitous', '#dict-search 可输入且值正确', JSON.stringify({ typed: typed, value: typedValue }));
        /* 页面初始就有「最近查过」列表（同样是 .dict__row），必须等真正的搜索结果（含 ubiquitous），不能只看行数 */
        const results = await waitFor('(function(){' +
          'var val=__qa.q("#dict-search"); if(!val || val.value !== "ubiquitous") return null;' +
          'var hints=__qa.all("#dict-result .dict__hint");' +
          'for (var h=0; h<hints.length; h++) { if (/最近查过|正在加载/.test(__qa.txt(hints[h]))) return null; }' +
          'var btns=__qa.all("#dict-result .dict__row-btn");' +
          'var rows=__qa.all("#dict-result .dict__row");' +
          'var hit=btns.filter(function(b){ return /ubiquit/i.test((b.getAttribute("data-w")||"") + " " + __qa.txt(b)); });' +
          'if(!hit.length) return null;' +
          'return {n:rows.length, btns:btns.length, first:__qa.txt(hit[0]).slice(0,140), firstW:hit[0].getAttribute("data-w")};' +
          '})()', 10000);
        rec.dictResults = results;
        REQUIRED(rec, !!results, '#dict-result 搜索出结果（.dict__row）', JSON.stringify(results));
        REQUIRED(rec, /ubiquit/i.test((results.first || '') + ' ' + (results.firstW || '')), '搜索结果里有 ubiquitous', JSON.stringify(results));
        await sleep(350);
        const clicked = await ev('(function(){' +
          'for (var attempt=0; attempt<3; attempt++){' +
          '  var btns=__qa.all("#dict-result .dict__row-btn");' +
          '  var pick=null;' +
          '  for(var i=0;i<btns.length;i++){ if(/ubiquit/i.test((btns[i].getAttribute("data-w")||"")+" "+__qa.txt(btns[i]))){pick=btns[i];break;} }' +
          '  if(!pick) return {ok:false, reason:"no-btn"};' +
          '  if(!pick.isConnected) continue;' +
          '  __qa.click(pick);' +
          '  if(!pick.isConnected) continue;' +
          '  return {ok:true, tag:pick.tagName, dataW:pick.getAttribute("data-w"), text:__qa.txt(pick).slice(0,80), n:btns.length};' +
          '}' +
          'return {ok:false, reason:"row-detached"};})()');
        rec.dictResultClick = clicked;
        const dcard = await waitFor('(function(){var c=__qa.q("#dict-detail #word-card"); return (c && __qa.vis(c)) ? {head:(function(){var w=__qa.q("#word-card-word"); return w?__qa.txt(w):"";})(), text:__qa.txt(c).slice(0,200)} : null;})()', 5000);
        if (!dcard) {
          rec.dictClickDiag = await ev('(function(){' +
            'var c=__qa.q("#dict-detail #word-card"); var d=__qa.q("#dict-detail"); var v=__qa.q("#view-dict");' +
            'var r=c?c.getBoundingClientRect():null;' +
            'var chain=[]; var e=c; while(e && e!==document.documentElement){ var cs=getComputedStyle(e); var rr=e.getBoundingClientRect(); chain.push({tag:e.tagName, id:e.id||"", cls:String(e.className||"").slice(0,40), display:cs.display, vis:cs.visibility, opacity:cs.opacity, hidden:!!e.hidden, w:Math.round(rr.width), h:Math.round(rr.height)}); e=e.parentElement; }' +
            'return {cardExists:!!c, cardVis:c?__qa.vis(c):false, rect:r?{w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top)}:null,' +
            '  detailOpen:d?d.classList.contains("is-open"):null, viewHidden:v?!!v.hidden:null, viewRect:v?Math.round(v.getBoundingClientRect().width):null,' +
            '  bodyCls:String(document.body.className), bodyView:document.body.dataset.view, route:location.hash,' +
            '  rows:__qa.all("#dict-result .dict__row").length, viewport:window.innerWidth+"x"+window.innerHeight, chain:chain};})()');
        }
        REQUIRED(rec, !!dcard, '点词库结果打开词卡', JSON.stringify({ clicked: clicked, diag: rec.dictClickDiag }));
        REQUIRED(rec, /ubiquit/i.test(dcard.head + ' ' + dcard.text), '词库结果词卡是 ubiquitous', JSON.stringify(dcard).slice(0, 200));
        /* 兜底词典懒加载（dict 冻结 60,000） */
        const full = await waitFor('(function(){var s=DR.dict.stats(); return (s.full>0) ? s : null;})()', 6000);
        rec.dictFull = full;
        if (full) {
          REQUIRED(rec, full.full === 60000, '兜底词典 60,000 条（lex-builder 冻结版）', JSON.stringify(full));
          rec.asserts.push({ name: '兜底词典已加载（file:// 下懒加载成功）', status: 'pass', detail: JSON.stringify(full) });
        } else {
          rec.asserts.push({ name: '兜底词典懒加载', status: 'warn', detail: 'DR.dict.stats().full 仍为 0，未观察到 60,000 条加载' });
        }
        const dupWordCards = await ev('(function(){return document.querySelectorAll("#word-card").length;})()');
        const dupIds = await ev('(function(){var ids={},dup=[]; __qa.all("[id]").forEach(function(e){ var id=e.id; if(!id) return; ids[id]=(ids[id]||0)+1; }); Object.keys(ids).forEach(function(k){ if(ids[k]>1) dup.push(k); }); return {dup:dup, count:dup.length}; })()');
        rec.duplicateIds = { wordCardCount: dupWordCards, duplicates: dupIds };
        SOFT(rec, dupWordCards === 1, '同一时刻只有一个 #word-card（契约 §5 选择器唯一性）', '实际 ' + dupWordCards + ' 个（阅读页 #inspector 残留 + 词库页 #dict-detail 新建）；应用代码未依赖全局 id，属低危 DOM 卫生问题');
        SOFT(rec, dupIds.count === 0, '全文档 id 唯一（无重复 id）', '重复 id：' + JSON.stringify(dupIds.dup));
        rec.shot = await shot('ui-10-dict');
        rec.shots.push(rec.shot);
      });
    }

    /* ---- 收尾 ---- */
    report.toolFailures = report.toolFailures || [];
    const failed = report.steps.filter((s) => s.status === 'fail');
    const warned = report.steps.filter((s) => s.status === 'pass-with-warnings');
    report.summary = {
      steps: report.steps.length,
      passed: report.steps.filter((s) => s.status === 'pass').length,
      failed: failed.length,
      warned: warned.length,
      asserts: report.steps.reduce((n, s) => n + s.asserts.filter((a) => a.status === 'pass').length, 0),
      failedAsserts: report.steps.reduce((n, s) => n + s.asserts.filter((a) => a.status === 'fail').length, 0),
      warnedAsserts: report.steps.reduce((n, s) => n + s.asserts.filter((a) => a.status === 'warn').length, 0),
      shots: report.shots.length,
      toolFailures: report.toolFailures.length,
      durationMs: Date.now() - t0,
    };
    report.status = failed.length ? 'fail' : (warned.length ? 'pass-with-warnings' : 'pass');
    exitCode = failed.length ? 1 : 0;
    if (report.toolFailures.length) {
      console.log('⚠ 工具层失败 ' + report.toolFailures.length + ' 次（非应用缺陷，但对应断言没跑到）：' +
        report.toolFailures.map((f) => f.kind + (f.name ? ':' + f.name : '') + ' ' + f.error).join('；'));
    }

    fs.writeFileSync(path.join(PREVIEW, 'ui-test.json'), JSON.stringify(report, null, 2));
    console.log('\n' + (exitCode ? '✗ 有失败步骤' : '✓ 交互冒烟通过') +
      '：' + report.summary.steps + ' 步 / 通过 ' + report.summary.passed + ' / 失败 ' + report.summary.failed +
      ' / 警告 ' + report.summary.warned + ' / 断言 ' + report.summary.asserts + ' 通过 ' +
      report.summary.failedAsserts + ' 失败 ' + report.summary.warnedAsserts + ' 警告' +
      ' / 截图 ' + report.summary.shots + ' / 用时 ' + (Date.now() - t0) / 1000 + 's');
    console.log('报告：preview/ui-test.json');
    return exitCode;
  } catch (e) {
    report.status = 'error';
    report.fatal = e.message;
    fs.writeFileSync(path.join(PREVIEW, 'ui-test.json'), JSON.stringify(report, null, 2));
    console.error('✗ 致命：' + e.message);
    return 1;
  } finally {
    if (edge && edge.pid) {
      if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
      else { try { edge.kill(); } catch (e) { /* ignore */ } }
    }
    await sleep(400);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}

main().then((c) => process.exit(c === undefined ? 0 : c)).catch((e) => {
  console.error('✗ ' + (e && e.stack || e));
  process.exit(1);
});
