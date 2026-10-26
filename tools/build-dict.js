#!/usr/bin/env node
/* 深读 DeepRead 词库构建脚本
 *
 * 产物（经典 <script> 可加载的全局变量文件，UTF-8 无 BOM / LF）：
 *   js/data/exam.js      window.DR_EXAM   六套考试词库合并（契约 §3.1）
 *   js/data/dict.js      window.DR_DICT   ECDICT 兜底词典（契约 §3.2）
 *   js/data/affixes.js   window.DR_AFFIX  前后缀词根（契约 §3.3）
 *
 * 数据来源（只读，不修改）：
 *   assets/vocab/{cet4,cet6,tem4,tem8,ielts,toefl}.json.gz
 *       来源：KyleBing/english-vocabulary (MIT) + ECDICT (MIT)，DSH_learninguse 整理
 *   tools/cache/vocab_raw/ecdict.csv
 *       来源：skywind3000/ECDICT (MIT)，770,611 行。本脚本只读
 *       word/phonetic/translation/tag/collins/oxford/bnc/frq/exchange，
 *       不读 definition/detail/audio。
 *   assets/dict/affixes.json.gz
 *       来源：DSH_learninguse 整理
 *
 * 用法：
 *   node tools/build-dict.js                 # 默认源路径 D:/ToolsSoftware/DSH_learninguse
 *   node tools/build-dict.js --src <dir>     # 指定 DSH_learninguse 根目录
 *
 * 无第三方依赖（只用 Node 内置 fs/path/zlib），可重复运行，产物确定。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT = arg('out', path.join(ROOT, 'js', 'data'));
const SRC = arg('src', 'D:/ToolsSoftware/DSH_learninguse');
const VOCAB_DIR = path.join(SRC, 'assets', 'vocab');
const ECDICT_CSV = path.join(SRC, 'tools', 'cache', 'vocab_raw', 'ecdict.csv');
const AFFIX_GZ = path.join(SRC, 'assets', 'dict', 'affixes.json.gz');

/* 六套考试词库（mask 位见契约 §3.1） */
const PACKS = [
  { id: 'cet4', name: '四级', bit: 1 },
  { id: 'cet6', name: '六级', bit: 2 },
  { id: 'tem4', name: '专四', bit: 4 },
  { id: 'tem8', name: '专八', bit: 8 },
  { id: 'ielts', name: '雅思', bit: 16 },
  { id: 'toefl', name: '托福', bit: 32 }
];
const PACK_META = {};
PACKS.forEach((p) => { PACK_META[p.id] = p.name; });

/* ECDICT tag → mask（契约 §3.2：cet4→1, cet6→2, ielts→16, toefl→32） */
const TAG_BITS = [['cet4', 1], ['cet6', 2], ['ielts', 16], ['toefl', 32]];

/* 规模预算（契约：exam ≤5MB、dict ≤6MB、三文件合计 ≤11MB；Lead 追加 exam ≤4.5MB）
   dict 拆两层：js/data/dict.js（常用 6 万，懒加载）+ js/data/d2/（其余按首字母分桶，点词时按需注入）。
   --dict-target / --dict-max-mb 可在实验中覆盖。 */
const EXAM_MAX_BYTES = 4.5 * 1024 * 1024;
const DICT_MAX_BYTES = Number(arg('dict-max-mb', 6)) * 1024 * 1024;
const TOTAL_MAX_BYTES = 11 * 1024 * 1024;

/* 释义策略（Lead 2026-10-26 清洗要求）：
   每条 ≤110 字、exam 每词性 ≤3 义项/合计 ≤6 义项；dict 每词性 ≤5/合计 ≤8。
   POS 顺序 n → v → adj → adv → 其他；同 POS 用「；」连接，POS 组之间两个空格。 */
const GLOSS_OPTS_EXAM = { maxChars: 110, perPos: 3, total: 6 };
const GLOSS_OPTS_DICT = { maxChars: 110, perPos: 5, total: 8 };
const DICT_TARGET = Number(arg('dict-target', 60000)); // 契约目标 50k–90k；取中低段保质量
const DICT_FORMS_RANK = 20000;  // rank ≤ 2 万才保留屈折词形（其余靠后缀规则还原）

/* ============================ 文本小工具 ============================ */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/* 领域标签行：[网络]/[医]/[计]/[化]/[法]/[经]…… 契约要求必须剔除 */
const RE_DOMAIN = /^\[[^\]]{1,16}\]\s*/;
/* 词性前缀：v. / vt. / vi. / n. / adj. / adv. / prep. / conj. / pron. /
   art. / num. / aux. / modal. / int. / abbr. / suf. / pref. / comb. 等，允许连写（≤3 段） */
const RE_POS = /^((?:[a-z]{1,6}\.){1,3})\s*/i;

function isCJK(s) { return CJK_RE.test(s || ''); }
function cjkCount(s) { return (String(s).match(/[\u4e00-\u9fff]/g) || []).length; }

/* 词性归一（输出标签按 Lead 要求：n/v/adj/adv/其他） */
const POS_CANON = {
  n: 'n', v: 'v', vt: 'v', vi: 'v', vbl: 'v',
  adj: 'adj', a: 'adj',
  adv: 'adv', ad: 'adv',
  prep: 'prep', conj: 'conj', pron: 'pron', art: 'art', num: 'num', det: 'art', pl: 'n',
  aux: 'aux', modal: 'modal', int: 'int', interj: 'int',
  abbr: 'abbr', suf: 'suf', pref: 'pref', comb: 'comb'
};
const POS_ORDER = ['n', 'v', 'adj', 'adv', 'prep', 'pron', 'conj', 'art', 'num', 'aux', 'modal', 'int', 'abbr', 'suf', 'pref', 'comb'];

function normPos(raw) {
  const p = String(raw || '').toLowerCase().replace(/\.+$/, '');
  for (const part of p.split('.')) {
    if (!part) continue;
    const c = POS_CANON[part];
    if (c) return c;
  }
  return 'other';
}

/* 中文释义标点/空白统一：半角逗号分号 → 全角，压空格；
   去掉内联 ASCII 方括号块（[医]/[网络]/[ə'bjuːz] 之类），去词首拉丁残渣 */
function cleanZhBody(s) {
  let x = String(s == null ? '' : s);
  x = x.replace(/\t+/g, ' ').replace(/\u00a0/g, ' ');
  x = x.replace(/\[[^\]]{1,40}\]/g, ' ');                    // [网络] [医] [读音] …
  x = x.replace(/["“”]/g, ' ');                              // 源数据里混入的引号
  x = x.replace(/英汉翻译\s*/g, '');                          // 源数据里的标签词
  x = x.replace(/[a-z]{1,3}&[a-z]{1,6}\.\s*/gi, ' ');      // "a&pron. 任一的" → "任一的"
  x = x.replace(/[ \u3000]{2,}/g, ' ');
  x = x.replace(/^[，；、,;:：.。&\s]+/, '');                 // 去掉行首空格/标点/&
  // 去掉词首的拉丁残渣（v&vi / n. / adj.[鱼] 之类），在其后是中文/中文标点时才切
  x = x.replace(/^[A-Za-z][A-Za-z&.\s'/]*?(?=[\u3400-\u9fff\u3000-\u303f…])/, '');
  x = x.replace(/[ \u3000]{2,}/g, ' ');
  x = x.replace(/ *, */g, '，').replace(/ *; */g, '；');
  x = x.replace(/ *、 */g, '、');
  x = x.replace(/ *(（|\(|）|\)) */g, '$1');
  x = x.replace(/／/g, '；');
  x = x.replace(/^[，；、,;:：.。&\s]+/, '').replace(/[，；、,;:：&\s]+$/, '');
  return x.trim();
}

/* 扩展层（dict2）专用的宽松清理：主清理丢弃的条目，这里尽量保住中文主体。
   只去掉领域标记、括号注记和省略号，不做质量判定；调用方保证只用于扩展层。 */
function lenientZh(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return '';
  const lines = s.split(/\\r\\n|\\n|\\r|\n/).map((x) => x.trim()).filter(Boolean);
  const groups = new Map();
  const order = [];
  for (let line of lines) {
    if (!line) continue;
    const m = line.match(RE_POS);
    const pos = m ? normPos(m[1]) : 'other';
    line = line.replace(/^\[[^\]]{1,16}\]\s*/, '');        // [法]/[经]/[网络] 前缀只去掉标记
    let body = cleanZhBody(line);
    body = body.replace(/[（(][^）)]*[）)]/g, ' ');        // （小山的）/ ( hilltop的复数形式 ) 去注记
    body = body.replace(/\.{2,}/g, '…').replace(/[ \u3000]{2,}/g, ' ').trim();
    body = body.replace(/^[，；、,;:：.。&\s]+/, '').replace(/[，；、,;:：&\s]+$/, '');
    if (!body || !isCJK(body) || cjkCount(body) === 0) continue;
    if (!groups.has(pos)) { groups.set(pos, []); order.push(pos); }
    groups.get(pos).push(body);
  }
  if (!order.length) return '';
  const parts = [];
  let total = 0;
  for (const pos of order) {
    if (total >= 2) break;                                  // 最多两个词性组，控制长度
    const body = groups.get(pos).slice(0, 2).join('；');
    if (!body) continue;
    if (body.length > 90) { parts.push(body.slice(0, 90)); total++; continue; }
    parts.push((pos && pos !== 'other' ? pos + '. ' : '') + body);
    total++;
  }
  return parts.join('  ');
}

function formatGloss(pos, body) {
  if (!body) return '';
  if (!pos || pos === 'other') return body;
  return pos + '. ' + body;
}

/* 按义项边界截断到 maxChars 内，不产生半个义项 */
function truncateGloss(s, maxChars) {
  s = String(s || '');
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const m = cut.search(/[；，、][^；，、]*$/);
  if (m > 20) return cut.slice(0, m).replace(/[；，、\s]+$/, '');
  return cut.replace(/[；，、\s]+$/, '');
}

/* 括号感知的义项切分：在 ，、；／ 等分隔符处切，不切括号内部（液体、气体等） */
function splitSegments(body) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(body || '')) {
    if ('（(【['.includes(ch)) depth++;
    else if ('）)】]'.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && '，,；;、／/'.includes(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* 去除空白/标点/全半角差异后的比较核心串 */
function glossCore(s) {
  return String(s || '')
    .replace(/[\s，,；;、。.!！?？:：·\-—–_/／（）()\[\]【】"'“”‘’]/g, '')
    .toLowerCase();
}

/* 明显不是释义的碎片（Lead 指定模式 + 实测垃圾） */
function isJunkSegment(seg) {
  const s = String(seg || '').trim();
  if (!s || !isCJK(s)) return true;
  if (cjkCount(s) === 0) return true;
  if (/auxiliary\s+verb/i.test(s)) return true;                 // auxiliary verb. at
  if (/\bs[bh]\s*[与在和]/.test(s)) return true;               // sb与 / sth在
  if (/在缺少|的情况下/.test(s)) return true;
  if (/^[a-z][a-z\s.'’,\-]*$/i.test(s)) return true;           // 纯英文字母残句
  if (/^[a-z].*\.["”’]?$/.test(s)) return true;                // 首字母小写的半句
  if (/^[\u4e00-\u9fff]{1,2}\.["”’]?/.test(s)) return true;    // "与." / "与. 有争执"
  if (/^[a-z]{1,5}(?=[\u4e00-\u9fff])/.test(s)) return true;   // ad尽管 / sb与
  if (/^[a-z]{1,3}&[a-z]{1,6}\./.test(s)) return true;         // a&pron. 任一的
  // 括号不配对（源数据截断，如 "生（过去式gendered"）
  if ((s.match(/[（(]/g) || []).length !== (s.match(/[）)]/g) || []).length) return true;
  if (/^[（(][^）)]{0,8}[）)][\u4e00-\u9fff]{0,2}$/.test(s)) return true; // (Be)人名 / (缅)拜
  if (/^(?:[（(][^）)]{0,8}[）)][\u4e00-\u9fff]{0,2})+$/.test(s)) return true; // (日)部(姓) / (朝)培
  if (/[（(]姓[）)]$/.test(s)) return true;
  if (/[（(][A-Za-z]{1,6}[）)]/.test(s) && cjkCount(s) <= 2) return true;
  // 音译注记：≥2 组括号且括号外只剩 ≤2 个汉字，如 (中)脱(普通话·威妥玛)
  const brackets = s.match(/[（(][^）)]*[）)]/g) || [];
  if (brackets.length >= 2 && cjkCount(s.replace(/[（(][^）)]*[）)]/g, '')) <= 2) return true;
  if (/^(人名|地名|姓氏)$/.test(s)) return true;
  if (/^(过去式|过去分词|现在分词|第三人称单数)/.test(s)) return true;
  if (/^(名词|动词|形容词|副词|介词|连词|代词)[A-Za-z]/.test(s)) return true;   // 名词decipherer
  if (/[（(](名词|动词|形容词|副词|介词|连词|代词)[A-Za-z]/.test(s)) return true; // 敌对的（名词adverseness）
  // 动词变位表注记：过去式gendered，过去分词gendered，现在分词…（≥2 个英文词）
  if (/(过去式|过去分词|现在分词|第三人称单数)/.test(s) && (s.match(/[A-Za-z]{2,}/g) || []).length >= 2) return true;
  return false;
}

/* 行首拉丁词性串（可能没有点/带 &）："aux. v&vi是" / "aux已经" / "ad&prep. 虽然" */
const POS_PRIORITY = ['aux', 'modal', 'n', 'v', 'prep', 'pron', 'adj', 'adv', 'conj', 'art', 'num', 'int', 'abbr', 'suf', 'pref', 'comb'];

function leadingPosRun(body) {
  const m = /^[A-Za-z][A-Za-z.&\s']*(?=[\u3400-\u9fff])/.exec(body);
  if (!m) return null;
  const tokens = m[0].split(/[.&\s']+/).filter(Boolean).map((t) => t.toLowerCase());
  return { len: m[0].length, tokens };
}

function pickPos(tokens) {
  for (const p of POS_PRIORITY) {
    if (tokens.some((t) => POS_CANON[t] === p)) return p;
  }
  return '';
}

/* 一行里可能塞了多个词性（如 "n. 放任；狂热 v. 遗弃；放弃"、"art. 这；那 adv. 更加…"），
   在行首和分隔符后的已知词性前缀处切开，返回 [{pos, body}] */
function splitPosChunks(line) {
  const raw = String(line || '');
  let s = raw.trim().replace(/^["“”'‘’\s]+/, '').replace(/["“”'‘’\s]+$/, '');
  if (!s) return [];
  // 词性前缀后若直接跟中文/括号（"adj.[鱼]" / "n.(To)"），补一个空格再切
  s = s.replace(/((?:[a-z]{1,6}\.){1,3})(?=[\u3400-\u9fff\[（(])/gi, '$1 ');
  s = s.replace(/英汉翻译(?=[a-z]{1,6}\.)/gi, '英汉翻译 ');   // 源数据标签后直接跟词性
  const bounds = [];
  const lead = RE_POS.exec(s);
  if (lead) bounds.push({ start: 0, bodyStart: lead[0].length, pos: lead[1] });
  else bounds.push({ start: 0, bodyStart: 0, pos: '' });
  const re = /(?:^|[\s；;，,、／"'“”‘’])((?:[a-z]{1,6}\.){1,3})\s+/gi;
  let m;
  while ((m = re.exec(s))) {
    if (m.index === 0) continue;
    const prefix = m[1];
    if (normPos(prefix) === 'other') continue;   // 不认识的「xx.」不当作词性
    const prefixStart = s.indexOf(prefix, m.index);
    const bodyStart = m.index + m[0].length;
    if (bodyStart <= bounds[bounds.length - 1].bodyStart) continue;
    bounds.push({ start: prefixStart, bodyStart, pos: prefix });
  }
  const out = [];
  for (let i = 0; i < bounds.length; i++) {
    const end = i + 1 < bounds.length ? bounds[i + 1].start : s.length;
    let body = s.slice(bounds[i].bodyStart, end).trim();
    let posTokens = String(bounds[i].pos || '').toLowerCase().replace(/\./g, ' ').split(/\s+/).filter(Boolean);
    // 行首（或本块开头）还挂着没有点/带 & 的词性串，如 "aux已经" / "ad&prep. 虽然" / "v&vi是"
    const run = leadingPosRun(body);
    if (run) {
      posTokens = posTokens.concat(run.tokens);
      body = body.slice(run.len).trim();
    }
    const pos = pickPos(posTokens);
    if (body) out.push({ pos, body });
  }
  return out;
}

/* 同 POS 义项去重：精确核心串去重 + 近似重复（一个是另一个前缀且长度差 <6）留长的 */
function dedupeSegments(segs) {
  const uniq = [];
  const seen = new Set();
  for (const seg of segs) {
    const core = glossCore(seg);
    if (!core || seen.has(core)) continue;
    seen.add(core);
    uniq.push({ seg, core });
  }
  const drop = new Set();
  // 长的优先保留；短的若是长串前缀且长度差 <6 → 丢弃
  const byLen = uniq.slice().sort((a, b) => b.core.length - a.core.length);
  for (let i = 0; i < byLen.length; i++) {
    for (let j = i + 1; j < byLen.length; j++) {
      const long = byLen[i].core;
      const short = byLen[j].core;
      if (long.length === short.length) continue;
      if (short.length < long.length && long.startsWith(short) && long.length - short.length < 6) {
        drop.add(byLen[j]);
      }
    }
  }
  return uniq.filter((x) => !drop.has(x)).map((x) => x.seg);
}

/* 释义合并（exam 与 dict 共用）：
   items: [{pos, body}] → 按 POS 归组、切义项、去重、过滤垃圾 → 定点数/字符上限输出 */
function mergeGlossItems(items, opts) {
  const groups = new Map();   // canonPos -> {pos, segs:[], order}
  const insertion = [];
  for (const it of items) {
    if (!it) continue;
    // 行内可能仍残留第二个词性（"…… 英汉翻译n. 恶意"），再切一次
    for (const sub of splitPosChunks(it.body)) {
      const pos = normPos(sub.pos || it.pos);
      const body = cleanZhBody(sub.body);
      if (!body || !isCJK(body)) continue;
      let g = groups.get(pos);
      if (!g) { g = { pos, segs: [], order: insertion.length }; groups.set(pos, g); insertion.push(pos); }
      for (const seg of splitSegments(body)) {
        if (!isJunkSegment(seg)) g.segs.push(seg);
      }
    }
  }
  if (!groups.size) return '';
  // POS 顺序：n → v → adj → adv → 其他（其余按首次出现顺序）
  const ordered = [];
  for (const p of POS_ORDER) if (groups.has(p)) ordered.push(groups.get(p));
  for (const p of insertion) if (!POS_ORDER.includes(p) && groups.has(p)) ordered.push(groups.get(p));

  const used = new Set();
  const outGroups = [];
  let totalSegs = 0;
  let outLen = 0;
  for (const g of ordered) {
    const segs = dedupeSegments(g.segs).filter((seg) => {
      const core = glossCore(seg);
      if (used.has(core)) return false;   // 跨词性去重（同一个释义不重复贴标签）
      return true;
    }).slice(0, opts.perPos);
    if (!segs.length) continue;
    const take = [];
    for (const seg of segs) {
      if (totalSegs >= opts.total) break;
      const candidate = formatGloss(g.pos, take.concat(seg).join('；'));
      const sep = outGroups.length ? '  ' : '';
      if (outLen + sep.length + candidate.length > opts.maxChars && take.length) break;
      take.push(seg);
      totalSegs++;
      for (const t of take) used.add(glossCore(t));
    }
    if (!take.length) continue;
    const str = formatGloss(g.pos, take.join('；'));
    outGroups.push(str);
    outLen += (outGroups.length > 1 ? 2 : 0) + str.length;
    if (outLen >= opts.maxChars) break;
  }
  return truncateGloss(outGroups.join('  '), opts.maxChars);
}

/* ECDICT 音标规范化：ә(Cyrillic)→ə、'→ˈ、:→ː、词首/音节前 , . →ˌ、ˊ→ˈ；
   多读法只留第一读法；注解 "(for v.)" 去掉、可选音 "(p)" 保留 */
function normalizeIpa(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/^\/+|\/+$/g, '').trim();
  // 多读法只留第一读法：";" 或 ", " / ",x"（≥3 段时）都是分隔符
  s = s.split(';')[0];
  if (/,\s/.test(s)) s = s.split(/,\s/)[0];
  else if ((s.match(/,/g) || []).length >= 2) s = s.split(',')[0];
  s = s.replace(/\(([^)]*)\)/g, (m, inner) => (/\s/.test(inner) ? '' : m));
  s = s
    .replace(/\u04d9/g, '\u0259')
    .replace(/[\u02ca\u0301\u0300]/g, '\u02c8')
    .replace(/\u0454/g, '\u025b')
    .replace(/\u03b5/g, '\u025b')
    .replace(/\u0261/g, 'g')
    .replace(/\u00a0/g, ' ')
    .replace(/:+/g, '\u02d0')
    .replace(/'/g, '\u02c8')
    .replace(/([,.])(?=\S)/g, '\u02cc')   // , . → ˌ（次重音）
    .replace(/[\\^?@`~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[\s\u02cc\u02c8-]+$/, ''); // 只清尾部悬空标记（保留词首重音）
  if (!/[\u0250-\uffff]|[a-z]/i.test(s)) return '';
  return s;
}

/* ============================ CSV 解析 ============================ */

/* 770,611 行 / 66MB；标准 CSV（双引号包裹、"" 转义）。逐行回调，不整表驻留。
   本数据字段内换行是字面 "\n"（反斜杠+n），状态机同时兼容真实换行。 */
function eachCSVRow(text, onRow) {
  let row = [];
  let field = '';
  let inQ = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      onRow(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); onRow(row); }
}

/* ECDICT exchange：p:过去式 d:过去分词 i:现在分词 3:三单 r:比较级 t:最高级
   s:复数 0:原形（该行是变形时） 1:原形的另一种写法 */
function parseExchange(ex) {
  const out = { base: '', forms: [] };
  if (!ex) return out;
  for (const part of String(ex).split('/')) {
    const ci = part.indexOf(':');
    if (ci < 0) continue;
    const code = part.slice(0, ci).trim().toLowerCase();
    const val = part.slice(ci + 1).trim();
    if (!val) continue;
    if (code === '0' || code === '1') {
      if (!out.base) out.base = val.toLowerCase();
    } else if (/^[pdi3rts]$/.test(code)) {
      for (const v of val.split(/[,;]/)) {
        const t = v.trim().toLowerCase();
        if (t) out.forms.push(t);
      }
    }
  }
  return out;
}

/* 单字词合法性（dict 用）：字母开头，字母/撇号/连字符，不含空格，不以符号结尾 */
function validSingleWord(w) {
  let s = String(w == null ? '' : w).trim().replace(/\u2019/g, "'");
  if (!s || /\s/.test(s)) return '';
  s = s.toLowerCase();
  if (!/^[a-z][a-z'-]*$/.test(s)) return '';
  if (!/^[a-z]$/.test(s) && !/[a-z]$/.test(s)) return '';
  if (s.includes('--') || s.length > 32) return '';
  if (s.length === 1 && s !== 'a' && s !== 'i') return '';
  if (/^[a-z]'[a-z]$/.test(s)) return '';   // n't / i'm 这类三字缩略残片
  return s;
}

/* ECDICT translation → 释义候选行：[{pos, body}]（领域行丢弃、裂字面换行、行内多词性切开） */
function parseTranslationLines(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return [];
  const lines = s.split(/\\r\\n|\\n|\\r|\n/).map((x) => x.trim()).filter(Boolean);
  const items = [];
  const seen = new Set();
  for (const line of lines) {
    if (RE_DOMAIN.test(line)) continue;
    for (const chunk of splitPosChunks(line)) {
      const body = chunk.body.trim();
      if (!body || !isCJK(body)) continue;
      const norm = glossCore(body);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      items.push({ pos: chunk.pos, body });
    }
  }
  return items;
}

/* ============================ 词形索引 ============================ */

const formIndex = {
  own: new Map(),  // 词头 → Set(屈折形式)
  rev: new Map()   // 屈折形式 → Set(词头)
};

function addForm(map, key, val) {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(val);
}

/* 取某词头的屈折形式：own 直查 + rev 反查，去自身、≤8 */
function formsFor(key) {
  const out = [];
  const seen = new Set([key]);
  const push = (f) => {
    if (!f || seen.has(f) || out.length >= 8) return;
    const v = validSingleWord(f);
    if (!v || v === key) return;
    seen.add(v);
    out.push(v);
  };
  const own = formIndex.own.get(key);
  if (own) for (const f of own) push(f);
  const rev = formIndex.rev.get(key);
  if (rev) for (const f of [...rev].sort()) push(f);
  return out;
}

/* ============================ 统计 ============================ */

const stats = {
  ecdictRows: 0,
  ecdictParseMs: 0,
  examSource: {},
  examWords: 0,
  examMultiword: 0,
  examWithExample: 0,
  examWithIpa: 0,
  examWithForms: 0,
  examZhMax: 0,
  examZhOver110: 0,
  dictStrictCandidates: 0,
  dictStrictAfterExam: 0,
  dictSuppCandidates: 0,
  dictExtraCandidates: 0,
  dictExtraAfterDedupe: 0,
  dictExtraBase: 0,
  dictExtraForm: 0,
  dictEntries: 0,
  dictWithIpa: 0,
  dictWithForms: 0,
  dictMaskDist: {},
  dictDroppedByTarget: 0,
  dictDroppedBySize: 0,
  dict2Entries: 0,
  dict2Bytes: 0,
  dict2Remaining: 0,
  dict2Buckets: {},
  dictPoolTotal: 0
};

/* ============================ exam ============================ */

function loadPack(id) {
  const file = path.join(VOCAB_DIR, id + '.json.gz');
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

/* exam 释义候选：把 t / d[] 每一行拆成 {pos, body}（行内多词性会再切开） */
function examGlossItems(raw) {
  const items = [];
  const push = (s) => {
    const line = String(s == null ? '' : s).trim();
    if (!line) return;
    if (RE_DOMAIN.test(line)) return;
    for (const chunk of splitPosChunks(line)) {
      if (isCJK(chunk.body)) items.push(chunk);
    }
  };
  if (Array.isArray(raw.d)) raw.d.forEach(push);
  push(raw.t);
  return items;
}

/* 例句质量：必须是完整英文句子（句首大写/引号开头 + 句末标点），优先带中译 */
function exampleScore(wordKey, en, zh) {
  const x = String(en == null ? '' : en).replace(/\s+/g, ' ').trim();
  const z = String(zh == null ? '' : zh).replace(/\s+/g, ' ').trim();
  if (!x || x.length < 12 || x.length > 240) return null;
  if (/[\uFFFD]/.test(x + z)) return null;
  if (/[a-z][A-Z]/.test(x)) return null;                    // 源数据粘连词（twoKings）
  if (!/^["'“‘(\[]?[A-Z]/.test(x)) return null;             // 句首大写 / 引号开头
  if (!/[.!?"'”’)\]]$/.test(x)) return null;                // 句末标点
  if (/^[.,;:!?]/.test(x) || /[,;:]\s*$/.test(x)) return null;
  const words = x.split(/\s+/);
  if (words.length < 3) return null;
  const stem = wordKey.replace(/[^a-z]/g, '');
  if (stem.length >= 3) {
    const probe = stem.length >= 6 ? stem.slice(0, Math.max(4, stem.length - 2)) : stem;
    if (!x.toLowerCase().replace(/[^a-z]/g, '').includes(probe)) return null;
  }
  let score = 0;
  if (z && z.length >= 2 && z.length <= 200 && isCJK(z)) score += 4;
  if (words.length >= 5) score += 1;
  return { x, z: score >= 4 && z ? z : '', score };
}

function collectExam() {
  const words = new Map();
  for (const pack of PACKS) {
    const data = loadPack(pack.id);
    const list = Array.isArray(data.words) ? data.words : [];
    stats.examSource[pack.id] = list.length;
    for (const raw of list) {
      const w0 = String(raw.w == null ? '' : raw.w).trim();
      if (!w0 || !/[A-Za-z]/.test(w0)) continue;
      const key = w0.toLowerCase().replace(/\u2019/g, "'");
      if (!key) continue;
      let e = words.get(key);
      if (!e) {
        e = { key, word: /^[A-Z][a-z']*$/.test(w0) ? w0 : key, ipa: '', items: [], ex: null, mask: 0, lvl: 0 };
        words.set(key, e);
      }
      if (/\s/.test(w0)) stats.examMultiword++;
      if (!e.ipa) e.ipa = String(raw.p == null ? '' : raw.p);
      for (const it of examGlossItems(raw)) e.items.push(it);
      e.mask |= pack.bit;
      const lvl = Number(raw.lvl) || 0;
      if (lvl > e.lvl) e.lvl = lvl;
      const sample = exampleScore(key, raw.x, raw.xm);
      if (sample && (!e.ex || sample.score > e.ex.score)) e.ex = sample;
    }
  }

  const rows = [];
  for (const key of [...words.keys()].sort()) {
    const e = words.get(key);
    const zh = mergeGlossItems(e.items, GLOSS_OPTS_EXAM);
    if (!zh) continue;
    const ipa = normalizeIpa(e.ipa);
    const lvl = Math.min(4, Math.max(1, e.lvl || 1)); // 源难度 1-5，按契约压到 1-4
    const forms = formsFor(key);
    const ex = e.ex ? e.ex.x : '';
    const exZh = e.ex ? e.ex.z : '';
    rows.push([e.word, ipa, zh, ex, exZh, e.mask, lvl, forms.join(' ')]);
    if (ex) stats.examWithExample++;
    if (ipa) stats.examWithIpa++;
    if (forms.length) stats.examWithForms++;
    if (zh.length > 110) stats.examZhOver110++;
    if (zh.length > stats.examZhMax) stats.examZhMax = zh.length;
  }
  stats.examWords = rows.length;
  return rows;
}

function writeExam(rows) {
  const head = EXAM_HEADER + 'window.DR_EXAM = { v: 1, packs: ' + JSON.stringify(PACK_META) + ', words: [';
  const tail = '] };\n';
  let body = rows.map((r) => JSON.stringify(r)).join(',');
  let total = Buffer.byteLength(head + body + tail, 'utf8');
  if (total > EXAM_MAX_BYTES) {
    // 防呆：理论上不会触发。先砍例句/词形，再缩减条数。
    body = rows.map((r) => JSON.stringify([r[0], r[1], r[2], '', '', r[5], r[6], ''])).join(',');
    total = Buffer.byteLength(head + body + tail, 'utf8');
    if (total > EXAM_MAX_BYTES) {
      const keep = Math.floor(rows.length * EXAM_MAX_BYTES / total * 0.98);
      body = rows.slice(0, keep).map((r) => JSON.stringify(r)).join(',');
      total = Buffer.byteLength(head + body + tail, 'utf8');
      stats.examTruncated = rows.length - keep;
    }
  }
  writeFile('exam.js', head + body + tail);
  return total;
}

/* ============================ ECDICT 扫描 ============================ */

const candidates = { strict: [], supp: [], extra: [] };

function scanEcdict() {
  const text = fs.readFileSync(ECDICT_CSV, 'utf8');
  let idx = null;
  let lineNo = 0;
  const t0 = Date.now();
  eachCSVRow(text, (row) => {
    lineNo++;
    if (!idx) {
      idx = {};
      row.forEach((name, i) => { idx[name] = i; });
      if (idx.word == null || idx.translation == null) throw new Error('ECDICT 表头异常：' + row.join(','));
      return;
    }
    const rawWord = row[idx.word] || '';
    const key = validSingleWord(rawWord);
    if (!key) return;
    const phonetic = row[idx.phonetic] || '';
    const translation = row[idx.translation] || '';
    const collins = Number(row[idx.collins]) || 0;
    const oxford = (row[idx.oxford] || '').trim() === '1';
    const tag = (row[idx.tag] || '').trim();
    const bnc = Number(row[idx.bnc]) || 0;
    const frq = Number(row[idx.frq]) || 0;
    const ex = parseExchange(row[idx.exchange] || '');
    if (ex.forms.length) for (const f of ex.forms) addForm(formIndex.own, key, f);
    if (ex.base) addForm(formIndex.rev, ex.base, key);

    const selected = !!tag || collins > 0 || oxford || bnc > 0 || frq > 0;
    const items = parseTranslationLines(translation);
    let zh = mergeGlossItems(items, GLOSS_OPTS_DICT);
    let lenient = false;
    if (!zh) {
      // 主清理会丢——领域行（[法]手铐）、括号注记（（小山的）山顶( hilltop的复数形式 )）、
      // 省略号短语（在...的范围）——的条目，用宽松清理再试一次，只进扩展层。
      zh = lenientZh(translation);
      lenient = true;
    }
    if (!zh) return;
    const base = {
      rawWord: rawWord.trim(), key, phonetic, zh, tag, bnc, frq,
      hasEx: ex.forms.length > 0, isForm: !!ex.base
    };
    if (lenient || (!selected && !phonetic)) {
      // 扩展层：主清理失败的、或没音标的生僻词，只进 dict2，不影响 dict.js 的构成
      candidates.extra.push(base);
      return;
    }
    if (!selected) {
      // 补充池：不满足契约选词规则，但有音标 + 干净中文释义的单字词，用于补足条数
      candidates.supp.push(base);
      return;
    }
    candidates.strict.push(base);
  });
  stats.ecdictRows = lineNo - 1;
  stats.ecdictParseMs = Date.now() - t0;
  stats.dictStrictCandidates = candidates.strict.length;
  stats.dictSuppCandidates = candidates.supp.length;
  stats.dictExtraCandidates = candidates.extra.length;
}

/* ============================ dict ============================ */

function maskOfTag(tag) {
  const bits = (tag || '').split(/\s+/);
  let m = 0;
  for (const [tagName, bit] of TAG_BITS) if (bits.includes(tagName)) m |= bit;
  return m;
}

function rankOf(bnc, frq) {
  const a = bnc > 0 ? bnc : 0;
  const b = frq > 0 ? frq : 0;
  return a && b ? Math.min(a, b) : (a || b || 0);
}

function displayWord(rawWord, key) {
  return /^[A-Z][a-z'-]*$/.test(rawWord) ? rawWord : key;
}

function buildDict(examKeys) {
  const toRecord = (r, rank) => ({
    key: r.key,
    w: displayWord(r.rawWord, r.key),
    ipa: r.phonetic,
    zh: r.zh,
    mask: maskOfTag(r.tag),
    rank,
    hasEx: r.hasEx,
    isForm: r.isForm,
    rich: r.zh.replace(/[^\u4e00-\u9fff]/g, '').length
  });
  const strict = candidates.strict.map((r) => toRecord(r, rankOf(r.bnc, r.frq)));
  const supp = candidates.supp.map((r) => toRecord(r, 0));
  const strictKeys = new Set(strict.map((r) => r.key));
  const strictFiltered = strict.filter((r) => !examKeys.has(r.key));
  stats.dictStrictAfterExam = strictFiltered.length;
  const cmpWord = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  // 严格池：rank 升序（0 最后）；同 rank 按字典序
  strictFiltered.sort((a, b) => {
    const ra = a.rank || Infinity;
    const rb = b.rank || Infinity;
    return ra !== rb ? ra - rb : cmpWord(a, b);
  });
  // 补充池：词头（非变形）优先 → 有屈折体系者 → 义项更丰富者
  const suppFiltered = supp
    .filter((r) => !examKeys.has(r.key) && !strictKeys.has(r.key))
    .sort((a, b) => {
      if (a.isForm !== b.isForm) return a.isForm ? 1 : -1;
      // 带连字符的复合词无法靠后缀规则还原，兜底词典里优先收
      const ca = a.key.includes('-') ? 1 : 0;
      const cb = b.key.includes('-') ? 1 : 0;
      if (ca !== cb) return cb - ca;
      if (a.hasEx !== b.hasEx) return a.hasEx ? -1 : 1;
      if (a.rich !== b.rich) return b.rich - a.rich;
      return cmpWord(a, b);
    });
  const suppKeys = new Set(supp.map((r) => r.key));
  // 扩展池：主清理失败 / 无音标的生僻词，排在最后，只可能落进 dict2.js。
  // 词头（非屈折形式）优先——屈折形式大多能被 lemmaCandidates 还原。
  const extra = candidates.extra.map((r) => toRecord(r, rankOf(r.bnc, r.frq)));
  const extraFiltered = extra
    .filter((r) => !examKeys.has(r.key) && !strictKeys.has(r.key) && !suppKeys.has(r.key))
    .sort((a, b) => {
      if (a.isForm !== b.isForm) return a.isForm ? 1 : -1;
      return cmpWord(a, b);
    });
  stats.dictExtraAfterDedupe = extraFiltered.length;
  stats.dictExtraBase = extraFiltered.filter((r) => !r.isForm).length;
  stats.dictExtraForm = extraFiltered.length - stats.dictExtraBase;
  const ordered = strictFiltered.concat(suppFiltered).concat(extraFiltered);

  const head = DICT_HEADER + 'window.DR_DICT = { v: 1, words: [';
  const tail = '] };\n';
  const budget = DICT_MAX_BYTES - Buffer.byteLength(head + tail, 'utf8') - 64;
  const parts = [];
  let bytes = 0;
  let withIpa = 0;
  let withForms = 0;
  let cursor = 0;
  const maskDist = {};
  for (; cursor < ordered.length; cursor++) {
    if (parts.length >= DICT_TARGET) break;
    const rec = ordered[cursor];
    const formsOn = rec.rank > 0 && rec.rank <= DICT_FORMS_RANK;
    let row = makeRow(rec, formsOn);
    let s = JSON.stringify(row);
    let len = Buffer.byteLength(s, 'utf8');
    if (bytes + len + 1 > budget && formsOn) {
      row = makeRow(rec, false);   // 超预算先舍弃低频词的词形，保住词条数
      s = JSON.stringify(row);
      len = Buffer.byteLength(s, 'utf8');
    }
    if (bytes + len + 1 > budget) { stats.dictDroppedBySize = ordered.length - parts.length; break; }
    parts.push(s);
    bytes += len + 1;
    if (row[1]) withIpa++;
    if (row[4]) withForms++;
    maskDist[row[3]] = (maskDist[row[3]] || 0) + 1;
  }
  stats.dictDroppedByTarget = Math.max(0, ordered.length - parts.length - stats.dictDroppedBySize);
  stats.dictEntries = parts.length;
  stats.dictWithIpa = withIpa;
  stats.dictWithForms = withForms;
  stats.dictMaskDist = maskDist;
  writeFile('dict.js', head + parts.join(',') + tail);

  /* ---------- 扩展层：按首字母分桶，点词未收录时只注入对应桶 ----------
     核心层 dict.js 放高频 6 万条；其余（生僻词、无音标词、主清理失败的条目）
     按首字母切成 27 个文件（a–z + `_` 兜底桶），单个约 0.5–1.5MB，
     点某个词查不到时才加载它所在的那个桶，不打首屏、也不打其它词。 */
  const buckets = new Map();
  let bucketEntries = 0;
  let bucketBytes = 0;
  for (let i = cursor; i < ordered.length; i++) {
    const rec = ordered[i];
    const ch = rec.key.charAt(0);
    const letter = /[a-z]/.test(ch) ? ch : '_';
    const s = JSON.stringify(makeRow(rec, false));
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter).push(s);
    bucketEntries++;
    bucketBytes += Buffer.byteLength(s, 'utf8') + 1;
  }
  const letters = Array.from(buckets.keys()).sort();
  const bucketStats = {};
  for (const letter of letters) {
    const rows = buckets.get(letter);
    const js = D2_HEADER(letter) + 'window.DR_D2 = window.DR_D2 || {};\n' +
      'window.DR_D2[' + JSON.stringify(letter) + '] = [' + rows.join(',') + '];\n';
    writeFile(path.join('d2', 'd2-' + letter + '.js'), js);
    bucketStats[letter] = { n: rows.length, bytes: Buffer.byteLength(js, 'utf8') };
  }
  stats.dict2Entries = bucketEntries;
  stats.dict2Bytes = bucketBytes;
  stats.dict2Buckets = bucketStats;
  stats.dictPoolTotal = ordered.length;
  stats.dict2Remaining = 0;

  function makeRow(rec, formsOn) {
    return [
      rec.w,
      normalizeIpa(rec.ipa),
      rec.zh,
      rec.mask,
      formsOn ? formsFor(rec.key).join(' ') : '',
      rec.rank
    ];
  }
}

/* ============================ affixes ============================ */

function buildAffixes() {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(AFFIX_GZ)).toString('utf8'));
  const src = Array.isArray(data.affixes) ? data.affixes : [];
  const items = [];
  for (const it of src) {
    const a = String(it.a == null ? '' : it.a).trim();
    if (!a) continue;
    items.push({
      a,
      type: String(it.type || '').trim(),
      zh: String(it.zh || '').trim(),
      ex: Array.isArray(it.ex) ? it.ex.map((x) => String(x)).filter(Boolean) : [],
      note: String(it.note || '').trim()
    });
  }
  const js = AFFIX_HEADER + 'window.DR_AFFIX = ' + JSON.stringify({ v: 1, items }) + ';\n';
  writeFile('affixes.js', js);
  return { count: items.length, bytes: Buffer.byteLength(js, 'utf8') };
}

/* ============================ 输出 ============================ */

function banner(extra) {
  return '/* ' + extra + '\n' +
    ' * 由 tools/build-dict.js 生成，请勿手改；重建：node tools/build-dict.js\n' +
    ' * 数据来源与许可：ECDICT（skywind3000/ECDICT, MIT）；六套考试词库\n' +
    ' * （KyleBing/english-vocabulary, MIT + ECDICT, MIT，经 DSH_learninguse 整理）；\n' +
    ' * 词根词缀（DSH_learninguse 整理）。详见 docs/DICT.md。\n' +
    ' */\n';
}
const EXAM_HEADER = banner('深读 DeepRead 考试词库 window.DR_EXAM（契约 CONTRACT.md §3.1）\n' +
  ' * 字段：[word, ipa, zh, ex, exZh, mask, lvl, forms]；mask bit: 1四级 2六级 4专四 8专八 16雅思 32托福；lvl 1-4');
const DICT_HEADER = banner('深读 DeepRead 兜底词典 window.DR_DICT（契约 CONTRACT.md §3.2）\n' +
  ' * 字段：[word, ipa, zh, mask, forms, rank]；mask bit: 1四级 2六级 16雅思 32托福；rank 频次序（0=未知）');
const D2_HEADER = (letter) => banner('深读 DeepRead 扩展词库桶 window.DR_D2[' + JSON.stringify(letter) + ']（契约 CONTRACT.md §3.4）\n' +
  ' * 首屏不加载；点词在 dict.js 里查不到时，只注入该词首字母对应的桶\n' +
  ' * 字段同 dict.js：[word, ipa, zh, mask, forms, rank]；扩展层不含屈折词形（forms 恒为空）');
const AFFIX_HEADER = banner('深读 DeepRead 词根词缀 window.DR_AFFIX（契约 CONTRACT.md §3.3）\n' +
  ' * 字段：{ a, type, zh, ex:[], note }');

function writeFile(name, content) {
  const target = path.join(OUT, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 原子写：先写临时文件再 rename，浏览器/验收脚本不会读到半截文件
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

function kb(n) { return Math.round(n / 1024) + 'KB（' + n + ' 字节）'; }

/* ============================ 主流程 ============================ */

function main() {
  if (!fs.existsSync(VOCAB_DIR)) throw new Error('找不到考试词库目录：' + VOCAB_DIR);
  if (!fs.existsSync(ECDICT_CSV)) throw new Error('找不到 ECDICT：' + ECDICT_CSV);
  if (!fs.existsSync(AFFIX_GZ)) throw new Error('找不到词缀数据：' + AFFIX_GZ);
  const t0 = Date.now();

  console.log('读取 ECDICT …（约 66MB，需数秒）');
  scanEcdict();
  console.log('  ECDICT 行数', stats.ecdictRows, '| 解析耗时', stats.ecdictParseMs + 'ms');

  console.log('合并六套考试词库 …');
  const examRows = collectExam();
  const examKeys = new Set(examRows.map((r) => r[0].toLowerCase().replace(/\u2019/g, "'")));
  const packTotal = Object.values(stats.examSource).reduce((a, b) => a + b, 0);
  console.log('  exam 词条', stats.examWords, '（源包合计', packTotal, '条）');
  writeExam(examRows);

  console.log('构建 dict …');
  buildDict(examKeys);

  console.log('构建 affixes …');
  const affixInfo = buildAffixes();

  const examSize = fs.statSync(path.join(OUT, 'exam.js')).size;
  const dictSize = fs.statSync(path.join(OUT, 'dict.js')).size;
  const affixSize = fs.statSync(path.join(OUT, 'affixes.js')).size;
  const total = examSize + dictSize + affixSize;

  console.log('\n==== 产物 ====');
  console.log('js/data/exam.js    ', stats.examWords, '条', kb(examSize));
  console.log('js/data/dict.js    ', stats.dictEntries, '条', kb(dictSize));
  console.log('js/data/d2/*.js    ', stats.dict2Entries, '条，', Object.keys(stats.dict2Buckets).length, '个桶',
    kb(stats.dict2Bytes), '（按需加载，不计入首屏）');
  console.log('js/data/affixes.js ', affixInfo.count, '条', kb(affixSize));
  console.log('首屏合计', kb(total), total <= TOTAL_MAX_BYTES ? '(≤11MB ✓)' : '(超 11MB ✗)');
  console.log('词库总池', stats.dictPoolTotal, '条 = dict.js', stats.dictEntries, '+ 扩展层', stats.dict2Entries);

  console.log('\n==== 统计 ====');
  console.log('exam 各包源词数', JSON.stringify(stats.examSource));
  console.log('exam 有例句', stats.examWithExample, '| 有音标', stats.examWithIpa, '| 有词形', stats.examWithForms);
  console.log('exam 释义最长', stats.examZhMax, '字符 | 超 110 字符', stats.examZhOver110, '条');
  console.log('exam 源库自带多词短语出现次数', stats.examMultiword, '（保留，不参与点词命中）');
  console.log('dict 严格选词候选', stats.dictStrictCandidates, '| 去掉 exam 重叠后', stats.dictStrictAfterExam, '| 补充候选', stats.dictSuppCandidates);
  console.log('dict 扩展池候选', stats.dictExtraCandidates, '| 去重后', stats.dictExtraAfterDedupe,
    '（词头', stats.dictExtraBase, '/ 屈折形式', stats.dictExtraForm, '，只进 dict2.js）');
  console.log('dict 有音标', stats.dictWithIpa, '| 有词形', stats.dictWithForms, '| 目标条数舍弃', stats.dictDroppedByTarget, '| 体积舍弃', stats.dictDroppedBySize);
  console.log('dict mask 分布', JSON.stringify(stats.dictMaskDist));
  console.log('dict2 扩展层', stats.dict2Entries, '条，', Object.keys(stats.dict2Buckets).length, '个桶 |', (stats.dict2Bytes / 1048576).toFixed(2) + 'MB');
  const bigBucket = Object.entries(stats.dict2Buckets).sort((a, b) => b[1].bytes - a[1].bytes)[0];
  if (bigBucket) console.log('  最大桶', bigBucket[0], bigBucket[1].n, '条', kb(bigBucket[1].bytes));
  console.log('耗时', Date.now() - t0 + 'ms');

  if (stats.examTruncated) console.warn('⚠ exam.js 因 4.5MB 上限截断词条：', stats.examTruncated);
  if (examSize > EXAM_MAX_BYTES) console.warn('⚠ exam.js 超过 4.5MB');
  if (dictSize > DICT_MAX_BYTES) console.warn('⚠ dict.js 超过 6MB');
  if (total > TOTAL_MAX_BYTES) console.warn('⚠ 数据合计超过 11MB');
  if (stats.dictEntries < 50000) console.warn('⚠ dict 条数低于契约目标 50k');
  if (stats.dict2Remaining > 0) console.warn('⚠ 扩展层仍有未落盘条目：', stats.dict2Remaining);
}

if (require.main === module) main();

module.exports = { splitPosChunks, mergeGlossItems, examGlossItems, parseTranslationLines, cleanZhBody, isJunkSegment, normalizeIpa, GLOSS_OPTS_EXAM, GLOSS_OPTS_DICT };
