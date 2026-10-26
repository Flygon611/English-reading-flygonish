#!/usr/bin/env node
/* 深读 DeepRead 词库验收报告
 *
 * 打印：条数 / 文件体积 / mask 分布 / 契约 §3.4 三段样本的 token 覆盖率 /
 *       20 词抽查（含对照源数据校验 mask）/ 5 个长释义样例 / 结构自检。
 *
 * 覆盖率的算法与实际运行期完全一致：用 js/engine/text.js 的 tokenizer 切词，
 * 用 js/core/dict.js 的 DR.dict.lookup 查词（exact → forms 反查 → 后缀还原），
 * 因此在 file:// 下点词命中什么，这里就统计什么。
 *
 * 用法：node tools/report-dict.js
 * 退出码：0 = 全部通过；1 = 结构错误或覆盖率不达标。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'js', 'data');
const SRC = 'D:/ToolsSoftware/DSH_learninguse';
const PACKS = [
  { id: 'cet4', bit: 1 }, { id: 'cet6', bit: 2 }, { id: 'tem4', bit: 4 },
  { id: 'tem8', bit: 8 }, { id: 'ielts', bit: 16 }, { id: 'toefl', bit: 32 }
];
const SAMPLES = [
  'It was a bright cold day in April, and the clocks were striking thirteen.',
  'The committee, which had been deliberating for nearly six hours, finally reached a conclusion that satisfied neither the union representatives nor the management.',
  'Scientists have discovered that the deep-sea creature, previously thought to be extinct, is capable of regenerating damaged tissue.'
];
const SPOT = [
  'the', 'of', 'and', 'to', 'be', 'have', 'will', 'go', 'went', 'left',
  'children', 'deliberate', 'ubiquitous', 'abandon', 'committee', 'scrutinize',
  'imminent', 'plausible', 'albeit', 'resilience'
];

const problems = [];
const warnings = [];
function fail(msg) { problems.push(msg); }
function warn(msg) { warnings.push(msg); }
function kb(n) { return (n / 1024).toFixed(0) + 'KB'; }

/* ---------- 1) 加载数据（与浏览器同样的全局变量方式） ---------- */
global.window = {};
function requireGlobal(rel) {
  const abs = path.join(ROOT, rel);
  delete require.cache[abs];
  require(abs);
}
requireGlobal('js/engine/text.js');
requireGlobal('js/data/exam.js');
requireGlobal('js/data/dict.js');
requireGlobal('js/data/affixes.js');
requireGlobal('js/core/dict.js');

const W = global.window;
const EXAM = W.DR_EXAM, DICT = W.DR_DICT, AFFIX = W.DR_AFFIX;
const TEXT = W.DR.text, D = W.DR.dict;
if (!EXAM || !Array.isArray(EXAM.words)) fail('window.DR_EXAM 缺失或格式错误');
if (!DICT || !Array.isArray(DICT.words)) fail('window.DR_DICT 缺失或格式错误');
if (!AFFIX || !Array.isArray(AFFIX.items)) fail('window.DR_AFFIX 缺失或格式错误');
if (!TEXT || typeof TEXT.words !== 'function') fail('DR.text 缺失');
if (!D || typeof D.lookup !== 'function') fail('DR.dict 缺失');
if (problems.length) {
  console.error('✗ 数据加载失败：');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
if (D.init) D.init();          // 先建 exam 索引（与页面启动顺序一致）
if (D.ensureFull) D.ensureFull(); // 同步 resolve（DR_DICT 已在内存里）

/* ---------- 2) 条数 / 体积 ---------- */
function sizeOf(name) { return fs.statSync(path.join(OUT, name)).size; }
const sizes = { exam: sizeOf('exam.js'), dict: sizeOf('dict.js'), affixes: sizeOf('affixes.js') };
const totalSize = sizes.exam + sizes.dict + sizes.affixes;

console.log('================ 深读 DeepRead 词库验收报告 ================\n');
console.log('## 1. 条数与体积');
console.log('  exam.js     ' + pad(EXAM.words.length, 6) + ' 条   ' + pad(kb(sizes.exam), 8) + '  (' + sizes.exam + ' 字节)  契约 ≤5MB，Lead 要求 ≤4.5MB');
console.log('  dict.js     ' + pad(DICT.words.length, 6) + ' 条   ' + pad(kb(sizes.dict), 8) + '  (' + sizes.dict + ' 字节)  契约 ≤6MB');
console.log('  affixes.js  ' + pad(AFFIX.items.length, 6) + ' 条   ' + pad(kb(sizes.affixes), 8) + '  (' + sizes.affixes + ' 字节)');
console.log('  合计        ' + pad('', 6) + '      ' + pad(kb(totalSize), 8) + '  (' + totalSize + ' 字节)  契约 ≤11MB');
if (sizes.exam > 5 * 1024 * 1024) fail('exam.js 超过 5MB');
if (sizes.exam > 4.5 * 1024 * 1024) warn('exam.js 超过 Lead 要求的 4.5MB');
if (sizes.dict > 6 * 1024 * 1024) fail('dict.js 超过 6MB');
if (totalSize > 11 * 1024 * 1024) fail('数据合计超过 11MB');

/* ---------- 3) mask 分布 ---------- */
const MASK_NAMES = { 1: '四级', 2: '六级', 4: '专四', 8: '专八', 16: '雅思', 32: '托福' };
function maskDist(rows, idx) {
  const bits = { 1: 0, 2: 0, 4: 0, 8: 0, 16: 0, 32: 0 };
  let zero = 0, multi = 0;
  for (const r of rows) {
    const m = r[idx] | 0;
    if (!m) { zero++; continue; }
    let n = 0;
    for (const b of [1, 2, 4, 8, 16, 32]) if (m & b) { bits[b]++; n++; }
    if (n > 1) multi++;
  }
  return { bits, zero, multi };
}
const em = maskDist(EXAM.words, 5);
const dm = maskDist(DICT.words, 3);
console.log('\n## 2. mask 分布（可多选，按位计数）');
console.log('  exam: ' + [1, 2, 4, 8, 16, 32].map((b) => MASK_NAMES[b] + ' ' + em.bits[b]).join(' | ') +
  ' | 多选 ' + em.multi + ' | 无 mask ' + em.zero);
console.log('  dict: ' + [1, 2, 16, 32].map((b) => MASK_NAMES[b] + ' ' + dm.bits[b]).join(' | ') +
  ' | 无 mask ' + dm.zero);
if (em.zero > 0) warn('exam 有 ' + em.zero + ' 条 mask=0（契约允许，但考试词库正常应为 0）');

/* ---------- 4) 结构自检 ---------- */
function checkRows(rows, count, label) {
  let badLen = 0, badZh = 0, badCjk = 0, domain = 0, badForms = 0, badWord = 0, maxZh = 0, over = 0;
  let multiword = 0;
  const keys = new Set();
  let dupKey = 0, dupPos = 0;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== count) { badLen++; continue; }
    const word = r[0], zh = r[2];
    // exam 允许源库自带的极少数多词短语（如 "in comparison with"），dict 契约明确只收单字词
    const wordRe = label === 'exam' ? /^[A-Za-z][A-Za-z'’\- ]*$/ : /^[A-Za-z][A-Za-z'’\-]*$/;
    if (typeof word !== 'string' || !wordRe.test(word)) badWord++;
    if (typeof word === 'string' && /\s/.test(word)) multiword++;
    const key = String(word).toLowerCase().replace(/\u2019/g, "'");
    if (keys.has(key)) dupKey++; else keys.add(key);
    if (typeof zh !== 'string') badZh++;
    else {
      if (!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(zh)) badCjk++;
      if (/\[[^\]]{1,16}\]/.test(zh)) domain++;
      if (zh.length > maxZh) maxZh = zh.length;
      if (zh.length > (label === 'exam' ? 160 : 120)) over++;
    }
    const forms = String(r[label === 'exam' ? 7 : 4] || '');
    const n = forms ? forms.split(/\s+/).filter(Boolean).length : 0;
    if (n > 8) badForms++;
    const prefixes = zh.match(/\b(n|v|adj|adv|prep|conj|pron|art|num|aux|modal|int|abbr)\.\s/g) || [];
    if (prefixes.length !== new Set(prefixes).size) dupPos++;
  }
  return { badLen, badZh, badCjk, domain, badForms, badWord, maxZh, over, dupKey, dupPos, keys, multiword };
}
const ec = checkRows(EXAM.words, 8, 'exam');
const dc = checkRows(DICT.words, 6, 'dict');
console.log('\n## 3. 结构自检');
console.log('  exam: 字段数错误 ' + ec.badLen + ' | 非法词头 ' + ec.badWord + ' | 多词短语 ' + ec.multiword +
  ' | 大小写重复 ' + ec.dupKey +
  ' | 无中文 ' + ec.badCjk + ' | 领域标记残留 ' + ec.domain + ' | >160 字符 ' + ec.over + '（最长 ' + ec.maxZh + '）' +
  ' | 词形>8 ' + ec.badForms + ' | 重复词性前缀 ' + ec.dupPos);
console.log('  dict: 字段数错误 ' + dc.badLen + ' | 非法词头 ' + dc.badWord + ' | 大小写重复 ' + dc.dupKey +
  ' | 无中文 ' + dc.badCjk + ' | 领域标记残留 ' + dc.domain + ' | >120 字符 ' + dc.over + '（最长 ' + dc.maxZh + '）' +
  ' | 词形>8 ' + dc.badForms + ' | 重复词性前缀 ' + dc.dupPos);
for (const [label, c] of [['exam', ec], ['dict', dc]]) {
  if (c.badLen) fail(label + ' 有 ' + c.badLen + ' 条字段数不符契约');
  if (c.badWord) fail(label + ' 有 ' + c.badWord + ' 条非法词头');
  if (c.dupKey) fail(label + ' 有 ' + c.dupKey + ' 条忽略大小写后重复');
  if (c.badCjk) fail(label + ' 有 ' + c.badCjk + ' 条释义无中文');
  if (c.domain) fail(label + ' 有 ' + c.domain + ' 条释义残留领域标记');
  if (c.over) fail(label + ' 有 ' + c.over + ' 条释义超长');
  if (c.badForms) fail(label + ' 有 ' + c.badForms + ' 条词形超过 8 个');
  if (c.dupPos) fail(label + ' 有 ' + c.dupPos + ' 条词性前缀重复');
  if (c.maxZh === 0 && label) fail(label + ' 释义为空');
}
/* 兜底词典不得含 exam 词 */
let overlap = 0;
for (const k of dc.keys) if (ec.keys.has(k)) overlap++;
console.log('  dict ∩ exam 重叠词条：' + overlap + (overlap === 0 ? '  ✓（契约要求不重复）' : '  ✗'));
if (overlap) fail('dict 与 exam 有 ' + overlap + ' 条重复');

/* ---------- 5) 三段样本 token 覆盖率 ---------- */
console.log('\n## 4. 三段样本 token 覆盖率（DR.text.words + DR.dict.lookup，大小写不敏感、允许屈折还原）');
let grandTotal = 0, grandHit = 0;
const grandMiss = new Map();
const viaCount = { exact: 0, form: 0, lemma: 0 };
SAMPLES.forEach((text, i) => {
  const toks = TEXT.words(text);
  let hit = 0;
  const miss = new Map();
  for (const tk of toks) {
    const res = D.resolve ? D.resolve(tk.w) : null;
    if (res) { hit++; viaCount[res.via] = (viaCount[res.via] || 0) + 1; }
    else miss.set(tk.w, (miss.get(tk.w) || 0) + 1);
  }
  grandTotal += toks.length;
  grandHit += hit;
  for (const [w, n] of miss) grandMiss.set(w, (grandMiss.get(w) || 0) + n);
  const pct = toks.length ? (hit / toks.length * 100) : 100;
  console.log('  样本 ' + (i + 1) + '：' + hit + '/' + toks.length + ' = ' + pct.toFixed(2) + '%' +
    (miss.size ? '   未覆盖：' + [...miss.keys()].join(', ') : '   未覆盖：无'));
});
const coverPct = grandTotal ? grandHit / grandTotal * 100 : 100;
console.log('  合计：' + grandHit + '/' + grandTotal + ' = ' + coverPct.toFixed(2) + '%   目标 ≥98%  ' +
  (coverPct >= 98 ? '✓ 达标' : '✗ 未达标'));
console.log('  命中方式：exact ' + viaCount.exact + ' | forms 反查 ' + viaCount.form + ' | 后缀还原 ' + viaCount.lemma);
if (grandMiss.size) {
  console.log('  未覆盖 token 清单（' + grandMiss.size + ' 个）：' + [...grandMiss.entries()].map(([w, n]) => w + (n > 1 ? '×' + n : '')).join(', '));
}
if (coverPct < 98) fail('三段样本 token 覆盖率 ' + coverPct.toFixed(2) + '% < 98%');

/* ---------- 6) 20 词抽查（含对照源数据校验 mask） ---------- */
console.log('\n## 5. 20 词抽查（DR.dict.lookup 实际运行路径）');
let sourceMask = null;
function loadSourceMasks() {
  const map = new Map();
  for (const pack of PACKS) {
    const file = path.join(SRC, 'assets', 'vocab', pack.id + '.json.gz');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    for (const w of data.words) {
      const key = String(w.w).toLowerCase().replace(/\u2019/g, "'");
      map.set(key, (map.get(key) || 0) | pack.bit);
    }
  }
  return map;
}
sourceMask = loadSourceMasks();
let spotBad = 0;
for (const w of SPOT) {
  const res = D.resolve ? D.resolve(w) : null;
  if (!res) { console.log('  ✗ ' + w + '  → 未查到'); spotBad++; continue; }
  const e = res.entry;
  const packs = (e.packs || []).join('/') || '—';
  let maskNote = '';
  if (sourceMask && sourceMask.has(String(e.w).toLowerCase()) && e.source === 'exam') {
    const expect = sourceMask.get(String(e.w).toLowerCase());
    const ok = expect === e.mask;
    if (!ok) { maskNote = '  ✗ mask 源=' + expect + ' 数据=' + e.mask; spotBad++; }
    else maskNote = '  mask✓';
  }
  console.log('  ' + pad(w, 14) + '→ ' + pad(e.w, 14) + ' ' + pad(e.source, 5) + ' via=' + pad(res.via, 5) +
    ' [' + (e.ipa || '无音标') + '] mask=' + pad(e.mask, 2) + ' packs=' + pad(packs, 18) + maskNote);
  console.log('       zh: ' + (e.zh || '').slice(0, 78));
  if (e.forms && e.forms.length) console.log('       forms: ' + e.forms.join(' '));
}
if (spotBad) fail(spotBad + ' 个抽查词未通过');

/* ---------- 7) 5 个长释义样例 ---------- */
console.log('\n## 6. 5 个最长释义样例（exam）');
[...EXAM.words].sort((a, b) => (b[2] || '').length - (a[2] || '').length).slice(0, 5)
  .forEach((r) => console.log('  [' + r[0] + '] (' + r[2].length + ' 字符) ' + r[2]));

/* ---------- 8) 功能词必查 ---------- */
const FUNC = ['the', 'of', 'and', 'to', 'be', 'have', 'will'];
const funcMiss = FUNC.filter((w) => !D.lookup(w));
console.log('\n## 7. 功能词必查：' + FUNC.join(' / ') + (funcMiss.length ? '  ✗ 缺失：' + funcMiss.join(',') : '  ✓ 全部可查'));
if (funcMiss.length) fail('功能词不可查：' + funcMiss.join(','));

/* ---------- 9) 汇总 ---------- */
console.log('\n================ 结论 ================');
if (warnings.length) { console.log('警告：'); warnings.forEach((w) => console.log('  ⚠ ' + w)); }
if (problems.length) {
  console.log('失败项（' + problems.length + '）：');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exitCode = 1;
} else {
  console.log('✓ 全部检查通过（exam ' + EXAM.words.length + ' 条 / dict ' + DICT.words.length + ' 条 / affixes ' +
    AFFIX.items.length + ' 条，覆盖率 ' + coverPct.toFixed(2) + '%）');
}
console.log('');

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
