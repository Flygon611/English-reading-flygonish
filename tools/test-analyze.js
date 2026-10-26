#!/usr/bin/env node
/* ============================================================================
 * test-analyze.js — 句子成分分析引擎评测
 *
 * 用法：node tools/test-analyze.js [--verbose] [--max-errors=40]
 *
 * 读 tools/gold-sentences.json（人工标注 POS 与主干成分跨度），跑 DR.analyze.sentence，
 * 按约定口径输出：
 *   1. POS 准确率（逐 token，按语境词性）
 *   2. 主干中心词准确率 —— 每个 gold 成分（subj/pred/obj/comp/aux）的中心词角色是否正确
 *   3. 主干成分边界准确率 —— structure 里是否有同角色、同首尾的跨度
 *   4. 短语内部标注可接受率 —— 逐 token 宽松口径：短语内的 det/attr/adv/prep/aux 视为可接受
 *   5. 过度标注 —— 主句内被标成骨架、但 gold 没有对应成分的 token（真问题指标）
 *   6. 完全正确句子数（中心词 + 边界都对、且主句无过度标注）
 *   7. 契约不变量 / 性能（单句 <20ms）/ 退化输入健壮性
 *
 * 目标（CONTRACT.md §4.2）：简单句 POS ≥ 85%、主干 ≥ 75%（此口径下取中心词准确率）。
 * 如实打印，不粉饰；退出码只在「契约不变量被破坏」时为 1。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const MAXERR = parseInt((argv.find(a => a.startsWith('--max-errors=')) || '').split('=')[1] || '40', 10);

/* ---------- 载入浏览器脚本 ---------- */
global.window = global;
function loadScript(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  (0, eval)(code);
}
loadScript('js/engine/text.js');
loadScript('js/engine/pos.js');
loadScript('js/engine/analyze.js');

const lexPath = path.join(ROOT, 'js/data/pos-lex.js');
if (!fs.existsSync(lexPath)) {
  console.error('!! 缺少 js/data/pos-lex.js，请先运行 node tools/build-pos.js');
  process.exit(2);
}
const lexBytes = fs.statSync(lexPath).size;
loadScript('js/data/pos-lex.js');
const lexSize = DR.analyze._installPos(DR_POS);

const gold = JSON.parse(fs.readFileSync(path.join(__dirname, 'gold-sentences.json'), 'utf8'));
const POS_SET = new Set(['noun', 'verb', 'adj', 'adv', 'prep', 'conj', 'pron', 'det', 'num', 'aux', 'modal', 'part', 'interj', 'propn']);
const ROLE_SET = new Set(['subj', 'pred', 'obj', 'comp', 'adv', 'attr', 'aux', 'det', 'prep', 'conj', 'mark', 'rel', 'nonfin', 'appos', '']);
const PHRASE_SET = new Set(['NP', 'VP', 'PP', 'AdjP', 'AdvP', 'Clause', 'InfP', 'GerP', 'PartP', '']);
const SKELETON = new Set(['subj', 'pred', 'obj', 'comp']);
/* 短语内部可接受的标注（不算错） */
const INTERNAL_OK = new Set(['det', 'attr', 'adv', 'prep', 'aux', 'nonfin', 'appos', 'mark', 'rel', 'conj', '']);

const invBreaks = [];
function inv(msg) { if (invBreaks.length < 30) invBreaks.push(msg); }

const stats = {
  posTotal: 0, posOk: 0,
  headTotal: 0, headOk: 0,
  boundTotal: 0, boundOk: 0,
  lenientTotal: 0, lenientOk: 0,
  overLabel: 0, overLabelSent: 0,
  exact: 0, sentences: 0,
  times: [],
  byLevel: {}
};
function bucket(level) {
  if (!stats.byLevel[level]) stats.byLevel[level] = { sents: 0, posT: 0, posO: 0, headT: 0, headO: 0, boundT: 0, boundO: 0, exact: 0 };
  return stats.byLevel[level];
}

/* gold 成分：同一角色的连续 token 段（aux 与 pred 分开） */
function goldComponents(tokens, roles) {
  const comps = [];
  let cur = null;
  for (let i = 0; i < roles.length; i++) {
    const r = roles[i] || '';
    if (cur && r === cur.role) { cur.end = i + 1; continue; }
    if (cur) comps.push(cur);
    cur = r ? { role: r, start: i, end: i + 1 } : null;
  }
  if (cur) comps.push(cur);
  return comps;
}
/* 成分中心词：NP 取最后一个名词/代词/数词；表语形容词取形容词；谓语取动词 */
function headIndex(tokens, comp) {
  const isN = p => p === 'noun' || p === 'propn' || p === 'pron' || p === 'num';
  for (let i = comp.end - 1; i >= comp.start; i--) {
    if (isN(tokens[i].pos)) return i;
  }
  if (comp.role === 'comp') {
    for (let i = comp.end - 1; i >= comp.start; i--) if (tokens[i].pos === 'adj') return i;
  }
  return comp.end - 1;
}

const worst = [];
for (const g of gold.sentences) {
  const rawWords = DR.text.words(g.text);
  const words = rawWords.map(w => w.w);
  if (words.length !== g.pos.length) inv(g.id + ': gold pos 长度 ' + g.pos.length + ' ≠ 词数 ' + words.length);
  if (g.roles.length !== words.length) inv(g.id + ': gold roles 长度不对');

  let r;
  const t0 = process.hrtime.bigint();
  try { r = DR.analyze.sentence(g.text); }
  catch (e) { inv(g.id + ': sentence() 抛异常: ' + e.message); continue; }
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  stats.times.push(dt);
  if (dt > 20) inv(g.id + ': 单句耗时 ' + dt.toFixed(1) + 'ms > 20ms');

  /* ---- 契约不变量 ---- */
  if (r.tokens.length !== words.length) inv(g.id + ': tokens ' + r.tokens.length + ' ≠ words ' + words.length);
  for (let i = 0; i < Math.min(r.tokens.length, rawWords.length); i++) {
    const tk = r.tokens[i], rw = rawWords[i];
    if (tk.t !== rw.t || tk.s !== rw.s || tk.e !== rw.e) inv(g.id + ': token[' + i + '] 偏移不一致');
    if (!POS_SET.has(tk.pos)) inv(g.id + ': token[' + i + '] pos 非法: ' + tk.pos);
    if (!ROLE_SET.has(tk.role)) inv(g.id + ': token[' + i + '] role 非法: ' + tk.role);
    if (!PHRASE_SET.has(tk.phrase)) inv(g.id + ': token[' + i + '] phrase 非法: ' + tk.phrase);
  }
  if (!(r.confidence >= 0 && r.confidence <= 1)) inv(g.id + ': confidence 越界');
  for (const c of r.clauses) if (!['main', 'coord', 'sub', 'rel', 'nonfinite'].includes(c.type)) inv(g.id + ': clause type 非法 ' + c.type);

  const b = bucket(g.level);
  b.sents++; stats.sentences++;

  /* ---- 1. POS ---- */
  const posErr = [];
  for (let i = 0; i < words.length; i++) {
    stats.posTotal++; b.posT++;
    if (r.tokens[i] && r.tokens[i].pos === g.pos[i]) { stats.posOk++; b.posO++; }
    else posErr.push({ i, w: words[i], gold: g.pos[i], pred: r.tokens[i] ? r.tokens[i].pos : '?' });
  }

  /* ---- 2/3/4. 主干中心词 / 边界 / 宽松 token ---- */
  const comps = goldComponents(r.tokens, g.roles);
  const headErr = [], boundErr = [], lenientErr = [];
  let allHeads = true, allBounds = true;
  const goldCovered = new Set();
  for (const c of comps) {
    for (let i = c.start; i < c.end; i++) goldCovered.add(i);
    const hi = headIndex(r.tokens, c);
    const headTok = r.tokens[hi];
    stats.headTotal++; b.headT++;
    if (headTok && headTok.role === c.role) { stats.headOk++; b.headO++; }
    else { allHeads = false; headErr.push({ i: hi, w: words[hi], gold: c.role, pred: headTok ? headTok.role : '?' }); }

    if (c.role !== 'aux') {
      stats.boundTotal++; b.boundT++;
      const spanStart = rawWords[c.start].s;
      const spanEnd = rawWords[c.end - 1].e;
      const hit = (r.structure || []).some(st => st.role === c.role && st.start === spanStart && st.end === spanEnd);
      if (hit) { stats.boundOk++; b.boundO++; }
      else { allBounds = false; boundErr.push({ role: c.role, text: g.text.slice(spanStart, spanEnd) }); }
    }

    /* 宽松逐 token */
    for (let i = c.start; i < c.end; i++) {
      stats.lenientTotal++; b.lenientT = (b.lenientT || 0);
      const pred = r.tokens[i] ? r.tokens[i].role : '';
      const isHead = i === hi;
      const ok = pred === c.role || (!isHead && INTERNAL_OK.has(pred));
      if (ok) { stats.lenientOk++; b.lenientO = (b.lenientO || 0) + 1; }
      else lenientErr.push({ i, w: words[i], gold: c.role, pred: pred || '空' });
    }
  }

  /* ---- 5. 过度标注：主句内被标骨架但 gold 没有（排除嵌套从句内部） ---- */
  const nestedRanges = (r.clauses || []).filter(c => c.type !== 'main' && c.type !== 'coord');
  function insideNestedChar(s, e) {
    return nestedRanges.some(nc => s >= nc.start && e <= nc.end);
  }
  let over = 0;
  const overWords = [];
  for (let i = 0; i < r.tokens.length; i++) {
    const t = r.tokens[i];
    if (!SKELETON.has(t.role)) continue;
    if (goldCovered.has(i)) continue;
    if (insideNestedChar(t.s, t.e)) continue;
    over++; overWords.push(words[i] + '/' + t.role);
  }
  if (over) { stats.overLabel += over; stats.overLabelSent++; }

  const exact = allHeads && allBounds && over === 0;
  if (exact) { stats.exact++; b.exact++; }

  if (VERBOSE || headErr.length || posErr.length || boundErr.length || overWords.length) worst.push({ g, r, posErr, headErr, boundErr, overWords, dt });
}

/* ---------- 输出 ---------- */
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
console.log('===============================================================');
console.log('深读 DeepRead · 句子分析评测（node tools/test-analyze.js）');
console.log('===============================================================');
console.log('pos-lex：' + lexSize + ' 词条，' + (lexBytes / 1024 / 1024).toFixed(2) + ' MB');
console.log('金标语料：' + stats.sentences + ' 句（人工标注 POS + 主干成分跨度）');
console.log('');
console.log('【1. POS 准确率】总体 ' + pct(stats.posOk, stats.posTotal) + '  (' + stats.posOk + '/' + stats.posTotal + ')');
for (const lv of ['simple', 'complex', 'long']) {
  const b = stats.byLevel[lv];
  if (b) console.log('     ' + lv.padEnd(8) + pct(b.posO, b.posT) + '  (' + b.posO + '/' + b.posT + ')');
}
console.log('');
console.log('【2. 主干中心词准确率】总体 ' + pct(stats.headOk, stats.headTotal) + '  (' + stats.headOk + '/' + stats.headTotal + ')');
for (const lv of ['simple', 'complex', 'long']) {
  const b = stats.byLevel[lv];
  if (b) console.log('     ' + lv.padEnd(8) + pct(b.headO, b.headT) + '  (' + b.headO + '/' + b.headT + ')');
}
console.log('');
console.log('【3. 主干成分边界准确率】总体 ' + pct(stats.boundOk, stats.boundTotal) + '  (' + stats.boundOk + '/' + stats.boundTotal + ')');
for (const lv of ['simple', 'complex', 'long']) {
  const b = stats.byLevel[lv];
  if (b) console.log('     ' + lv.padEnd(8) + pct(b.boundO, b.boundT) + '  (' + b.boundO + '/' + b.boundT + ')');
}
console.log('');
console.log('【4. 短语内部标注可接受率（宽松逐 token）】' + pct(stats.lenientOk, stats.lenientTotal) + '  (' + stats.lenientOk + '/' + stats.lenientTotal + ')');
console.log('【5. 过度标注】' + stats.overLabel + ' 个 token，涉及 ' + stats.overLabelSent + ' 句（主句内被标骨架但 gold 没有）');
console.log('【6. 完全正确句子】' + stats.exact + '/' + stats.sentences + '  (' + pct(stats.exact, stats.sentences) + ')');

const simple = stats.byLevel['simple'];
const simplePos = simple ? simple.posO / simple.posT : 0;
const simpleHead = simple ? simple.headO / simple.headT : 0;
const passPos = simplePos >= 0.85;
const passHead = simpleHead >= 0.75;
console.log('');
console.log('【目标检查】简单句 POS ≥ 85% → ' + (passPos ? 'PASS' : 'FAIL') + ' (' + (simplePos * 100).toFixed(1) + '%)' +
  ' ; 主干中心词 ≥ 75% → ' + (passHead ? 'PASS' : 'FAIL') + ' (' + (simpleHead * 100).toFixed(1) + '%)');

/* 性能 */
const times = stats.times.slice().sort((a, b) => a - b);
if (times.length) {
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log('【性能】平均 ' + avg.toFixed(2) + 'ms，中位 ' + times[Math.floor(times.length / 2)].toFixed(2) +
    'ms，最大 ' + times[times.length - 1].toFixed(2) + 'ms（目标 <20ms）');
}

/* ---------- 错误样例 ---------- */
console.log('');
console.log('【错误样例】按主干中心词错误排序（最多 ' + MAXERR + ' 句）');
worst.sort((a, b) => (b.headErr.length * 2 + b.boundErr.length) - (a.headErr.length * 2 + a.boundErr.length));
let shown = 0;
for (const w of worst) {
  if (!w.headErr.length && !w.boundErr.length && !w.overWords.length) continue;
  if (shown++ >= MAXERR) break;
  console.log('- ' + w.g.id + ' [' + w.g.level + '] ' + w.g.text);
  if (w.headErr.length) console.log('    中心词错误: ' + w.headErr.map(e => e.w + ' ' + e.gold + '→' + (e.pred || '空')).join(' | '));
  if (w.boundErr.length) console.log('    边界缺失: ' + w.boundErr.map(e => e.role + '「' + e.text + '」').join(' | '));
  if (w.posErr.length) console.log('    POS 错误: ' + w.posErr.map(e => e.w + ' ' + e.gold + '→' + (e.pred || '空')).join(' | '));
  if (w.overWords.length) console.log('    过度标注: ' + w.overWords.join(' '));
  if (w.r.summary) console.log('    引擎 summary: ' + w.r.summary + '  conf=' + w.r.confidence);
}

/* ---------- 退化输入 ---------- */
console.log('');
console.log('【退化输入健壮性】');
const degenerate = [
  '', '   ', '!!!', '...', '—', '"', 'The.', 'THE QUICK BROWN FOX',
  'the old man with a hat', '12345 67 89', 'He said, "Stop!" — and left.',
  'A'.repeat(200), 'word '.repeat(300).trim(),
  'This sentence has (parentheses) and — dashes — and "quotes" mixed, okay.',
  '，，，。。。！！！'
];
let degOk = true;
for (const d of degenerate) {
  let r;
  try { r = DR.analyze.sentence(d); }
  catch (e) { degOk = false; console.log('  THROW on ' + JSON.stringify(d.slice(0, 30)) + ': ' + e.message); continue; }
  const words = DR.text.words(d);
  if (r.tokens.length !== words.length) { degOk = false; console.log('  MISALIGN on ' + JSON.stringify(d.slice(0, 30))); }
  if (!(r.confidence >= 0 && r.confidence <= 1)) { degOk = false; console.log('  conf 越界 on ' + JSON.stringify(d.slice(0, 30))); }
  if (VERBOSE) console.log('  ok ' + JSON.stringify(d.slice(0, 24)) + ' words=' + words.length + ' conf=' + r.confidence + ' summary=' + JSON.stringify(r.summary));
}
console.log(degOk ? '  全部退化输入：不抛异常、tokens 对齐 ✔' : '  ** 退化输入有问题 **');
if (!degOk) invBreaks.push('degenerate-input');

/* ---------- 契约不变量 ---------- */
console.log('');
if (invBreaks.length) {
  console.log('【契约不变量】** 失败 **');
  for (const m of invBreaks) console.log('  - ' + m);
} else {
  console.log('【契约不变量】tokens/pos/role/phrase/clause/confidence 全部合法 ✔');
}
const probe = 'It was a bright cold day in April, and the clocks were striking thirteen.';
const rp = DR.analyze.sentence(probe);
const rw = DR.text.tokenize(probe).filter(t => t.k === 'w');
console.log('【token 对齐抽查】tokenize 单词 token ' + rw.length + ' 个，分析 tokens ' + rp.tokens.length + ' 个 → ' +
  (rw.length === rp.tokens.length && rw.every((t, i) => rp.tokens[i].s === t.s && rp.tokens[i].e === t.e) ? 'OK' : '** 不一致 **'));

console.log('');
console.log('（规则启发式，允许出错；口径与已知错误类型见 docs/ANALYSIS.md）');
process.exit(invBreaks.length ? 1 : 0);
