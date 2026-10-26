#!/usr/bin/env node
/* ============================================================================
 * build-pos.js — 生成 js/data/pos-lex.js（window.DR_POS）
 *
 * 数据来源：
 *   - ECDICT (MIT, skywind3000/ECDICT)
 *     D:\ToolsSoftware\DSH_learninguse\tools\cache\vocab_raw\ecdict.csv
 *     definition 的 WordNet 词性前缀（n./v./a./s./r.，也兼容无点写法 n / v / a / s / r）
 *     translation 的中文词性前缀（n./vt./vi./a./adj./adv./prep./pron./conj./num./art./aux.…）
 *     exchange 屈折形式（p:过去式 d:过去分词 i:现在分词 3:三单 s:复数 r:比较级 t:最高级 0:原形）
 *     bnc / frq 频次（用于排序与体积裁剪）
 *   - kaikki-en-extract.json（Wiktionary 抽取，用于校正高频词的词性）
 *
 * 输出契约（CONTRACT.md §4.2）：
 *   window.DR_POS = { v:1, w:{ 'word':'noun', ... } }   // 每个词一个主词性
 *   pos 取值：noun|verb|adj|adv|prep|conj|pron|det|num|aux|modal|part|interj|propn
 *
 * 说明：本表每个词只存「一个」主词性（契约形态要求），上下文的歧义消解由
 * js/engine/pos.js 的规则完成（冠词后→名词、情态动词后→动词等）。
 *
 * 体积上限 5 MB（契约 §4.2）：超出时按频次从低到高裁剪，先保高频与屈折形式。
 *
 * 用法：node tools/build-pos.js [--max-mb=4.9]
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ECDICT = 'D:\\ToolsSoftware\\DSH_learninguse\\tools\\cache\\vocab_raw\\ecdict.csv';
const KAIKKI = 'D:\\ToolsSoftware\\DSH_learninguse\\tools\\cache\\kaikki-en-extract.json';
const OUT = path.join(ROOT, 'js', 'data', 'pos-lex.js');

const argMax = (process.argv.find(a => a.startsWith('--max-mb=')) || '').split('=')[1];
const MAX_MB = parseFloat(argMax || '4.9');

/* 契约词性集合；内部候选名 → 契约名 */
const CANON = {
  n: 'noun', noun: 'noun',
  v: 'verb', verb: 'verb', vt: 'verb', vi: 'verb',
  a: 'adj', s: 'adj', adj: 'adj',
  r: 'adv', adv: 'adv', ad: 'adv',
  prep: 'prep', conj: 'conj', pron: 'pron',
  det: 'det', art: 'det', article: 'det',
  num: 'num', aux: 'aux', modal: 'modal', part: 'part', particle: 'part',
  int: 'interj', interj: 'interj', intj: 'interj', propn: 'propn', name: 'propn'
};

/* 翻译行前缀 → 候选词性。长的优先匹配。 */
const TR_PREFIX = [
  ['vt.', 'v'], ['vi.', 'v'], ['v.', 'v'],
  ['adj.', 'a'], ['a.', 'a'],
  ['adv.', 'r'], ['ad.', 'r'], ['ad', 'r'],
  ['prep.', 'prep'], ['pron.', 'pron'], ['conj.', 'conj'],
  ['num.', 'num'], ['art.', 'art'], ['aux.', 'aux'],
  ['int.', 'int'], ['interj.', 'int'], ['abbr.', 'n'], ['pl.', 'n'],
  ['suf.', ''], ['pref.', ''], ['comb.', ''], ['phr.', '']
];

/* 弱形态线索：只在前两项都没信号时兜底 */
const SUFFIX = [
  [/(?:tion|sion|ment|ness|ity|ism|ist|ance|ence|ship|hood|age|ure|ance)$/, 'n', 1.0],
  [/(?:ous|ful|able|ible|ive|less|ical|ic|ish|esque)$/, 'a', 1.0],
  [/(?:ize|ise|ify)$/, 'v', 1.0],
  [/(?:ly)$/, 'r', 1.0]
];

/* WordNet 定义行：带点 "n. ..." 或无点 "n ..."；行首单词类的其它写法也认 */
function defLinePos(line) {
  let m;
  if ((m = /^(n|v|a|s|r)\.\s/.exec(line))) return m[1];
  if ((m = /^(n|v|a|s|r)\s/.exec(line))) return m[1];
  if ((m = /^(noun|verb|adj|adv|preposition|pronoun|conjunction|determiner|article|numeral|interjection)\b/i.exec(line)))
    return ({ noun: 'n', verb: 'v', adj: 'a', adv: 'r', preposition: 'prep', pronoun: 'pron', conjunction: 'conj', determiner: 'det', article: 'det', numeral: 'num', interjection: 'int' })[m[1].toLowerCase()];
  return '';
}

/* 定义里形如 "p. pr. & vb. n. of X" / "imp. & p. p. of X" / "past participle of X" / "plural of X"
   的屈折说明 → 屈折类别（form kind）。 */
function defLineForm(line) {
  const s = line.toLowerCase();
  if (/^(imp\.|past\b|past tense|p\. pr|present participle|p\. p\.|past participle)/.test(s)) return 'verb-form';
  if (/^(plural|pl\.|plu)/.test(s)) return 'plural';
  if (/^(comparative|superlative)\b/.test(s)) return 'degree';
  if (/^(third[- ]person|3rd person)/.test(s)) return 'verb-form';
  if (/^[a-z ]*ing of\b/.test(s)) return 'verb-form';
  return '';
}

/* 解析一行 ECDICT CSV（字段内换行是字面 \n 两字符，因此一行就是一条记录） */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* ---------- 1. kaikki 词性票（高频词校正） ---------- */
function loadKaikki() {
  const votes = Object.create(null); // word -> {pos: count}
  let n = 0;
  if (!fs.existsSync(KAIKKI)) { console.warn('! kaikki 缺失，跳过：' + KAIKKI); return votes; }
  const raw = fs.readFileSync(KAIKKI, 'utf8');
  const j = JSON.parse(raw);
  for (const word of Object.keys(j)) {
    const sense = (j[word] && j[word].senses) || [];
    const m = Object.create(null);
    for (const s of sense) {
      const rawPos = String(s.pos || '').toLowerCase();
      if (rawPos === 'name' || rawPos === 'character' || rawPos === 'symbol' || rawPos === 'punct') continue;
      const p = CANON[rawPos];
      if (p) m[p] = (m[p] || 0) + 1;
    }
    if (Object.keys(m).length) { votes[word.toLowerCase()] = m; n++; }
  }
  console.log('· kaikki 词条：' + n);
  return votes;
}

/* 第二候选词性：票数足够、且是实词（功能词另有表），只留一个 */
const CONTENT = { verb: 1, noun: 1, adj: 1, adv: 1 };
function altOf(votes, cands) {
  if (cands.length < 2) return '';
  const top = votes[cands[0]];
  for (let i = 1; i < cands.length && i < 3; i++) {
    const p = CANON[cands[i]];
    if (p && CONTENT[p] && votes[cands[i]] >= top * 0.45) return p;
  }
  return '';
}

/* ---------- 2. 逐行读 ECDICT，算每个词的词性票 ---------- */
function buildVotes(kaikki) {
  return new Promise((resolve, reject) => {
    const lineReader = require('readline').createInterface({
      input: fs.createReadStream(ECDICT, 'utf8'),
      crlfDelay: Infinity
    });
    const words = Object.create(null); // word -> {votes:{pos:w}, rank, incl}
    let header = null;
    let rows = 0;
    lineReader.on('line', line => {
      if (!header) { header = parseCsvLine(line); return; }
      if (!line || line.length < 4) return;
      const r = parseCsvLine(line);
      const raw = r[0] || '';
      if (!/^[A-Za-z][A-Za-z'’\-]*$/.test(raw)) return;
      if (raw.length > 40) return;
      rows++;
      const w = raw.toLowerCase();
      const def = r[2] || '';
      const tr = r[3] || '';
      const exch = r[10] || '';
      const bnc = parseInt(r[8], 10) || 0;
      const frq = parseInt(r[9], 10) || 0;

      const votes = Object.create(null);
      const bump = (p, wgt) => { if (p) votes[p] = (votes[p] || 0) + wgt; };

      /* 2.1 WordNet 定义：每个词性行 2 分，最多计 4 行/类 */
      let defPOS = '';
      if (def) {
        const cnt = Object.create(null);
        for (const ln of def.split('\\n')) {
          const t = ln.trim();
          if (!t) continue;
          const fp = defLineForm(t);
          if (fp === 'verb-form') bump('v', 1.2);
          else if (fp === 'plural') bump('n', 1.2);
          else if (fp === 'degree') bump('a', 0.8);
          const p = defLinePos(t);
          if (!p) continue;
          defPOS = p;
          if ((cnt[p] = (cnt[p] || 0) + 1) <= 4) bump(p, 2.0);
        }
      }

      /* 2.2 中文释义前缀：每行 1 分，最多 6 行；跳过 [领域] 行 */
      let trHits = 0;
      if (tr) {
        for (const ln of tr.split('\\n')) {
          const t = ln.trim();
          if (!t || t[0] === '[') continue;        // [医] [网络] [人名] … 领域/专名行
          if (t[0] === '(') continue;              // (re-…) 之类
          for (const [pfx, cand] of TR_PREFIX) {
            if (t.startsWith(pfx)) {
              if (cand && trHits < 6) { bump(cand, 1.0); trHits++; }
              break;
            }
          }
        }
      }

      /* 2.3 屈折形式：exchange 首字段 0:lemma/1:flags */
      let lemma = '';
      let flags = '';
      if (exch) {
        const m = /^0:([^/]*)(?:\/1:([a-z]*))?/.exec(exch);
        if (m) { lemma = m[1].toLowerCase(); flags = m[2] || ''; }
      }
      if (lemma && flags) {
        if (/[pdi3]/.test(flags)) bump('v', 1.6);
        if (/s/.test(flags)) bump('n', 1.4);
        if (/[rt]/.test(flags)) bump('a', 1.0);
      }

      /* 2.4 kaikki（Wiktionary）校正 */
      const kv = kaikki[w];
      if (kv) {
        const keys = Object.keys(kv).sort((a, b) => kv[b] - kv[a]).slice(0, 3);
        for (const p of keys) bump(p, Math.min(kv[p], 4) * 2.6);
      }

      /* 2.5 词形兜底 */
      const suff = [];
      for (const [re, p, wgt] of SUFFIX) if (re.test(w)) { suff.push(p); bump(p, wgt); }

      /* 记录：主词性 */
      const cands = Object.keys(votes);
      if (!cands.length) return;
      const PRIORITY = ['v', 'n', 'a', 'r', 'prep', 'pron', 'det', 'conj', 'num', 'aux', 'modal', 'part', 'int'];
      cands.sort((A, B) => (votes[B] - votes[A]) || (PRIORITY.indexOf(A) - PRIORITY.indexOf(B)));
      const best = CANON[cands[0]] || 'noun';
      const rank = (bnc > 0 && frq > 0) ? Math.min(bnc, frq) : (bnc || frq || 0);
      const prev = words[w];
      if (!prev) {
        words[w] = { pos: best, alt: altOf(votes, cands), rank: rank || 0, def: !!defPOS, form: !!lemma, tr: !!tr };
      } else {
        /* 同一拼写可能出现多行（形态行 + 词条行）：保留信息量更高的 */
        const altNow = altOf(votes, cands);
        if (!prev.def && defPOS) { prev.pos = best; prev.def = true; if (altNow && altNow !== best) prev.alt = altNow; }
        else if (altNow && prev.pos !== altNow) {
          /* 已有主词性时，把第二候选补进 alt（只留一个） */
          if (!prev.alt || prev.alt === prev.pos) prev.alt = altNow !== best ? altNow : (altNow === prev.pos ? prev.alt : altNow);
        }
        if (!prev.rank || (rank && rank < prev.rank)) prev.rank = rank || prev.rank;
        if (lemma) prev.form = true;
      }

    });
    lineReader.on('close', () => {
      console.log('· ECDICT 单行词条（候选）：' + rows);
      resolve({ words, header });
    });
    lineReader.on('error', reject);
  });
}

/* ---------- 3. 裁剪 + 写出 ---------- */
function emit(words) {
  const entries = [];
  for (const w of Object.keys(words)) {
    const e = words[w];
    let pri = 3;                                  // 0 最高
    if (e.rank > 0) pri = 0;
    else if (e.def) pri = 1;
    else if (e.form) pri = 2;
    entries.push({ w, pos: e.pos, alt: e.alt || '', rank: e.rank || 0, pri, form: e.form });
  }
  /* 排序：频次已知 → 有 WordNet 释义 → 屈折形式 → 其余（都按 rank 升序，同 rank 按词长/字母） */
  entries.sort((a, b) => (a.pri - b.pri) || ((a.rank || 1e9) - (b.rank || 1e9)) || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0));

  const limit = Math.floor(MAX_MB * 1024 * 1024);
  const parts = [];
  let bytes = 0;
  let kept = 0;
  let dropped = 0;
  for (const e of entries) {
    const chunk = JSON.stringify(e.w) + ':' + JSON.stringify(e.pos + (e.alt && e.alt !== e.pos ? '|' + e.alt : ''));
    const add = chunk.length + 1;
    if (bytes + add > limit) { dropped++; continue; }
    parts.push(chunk);
    bytes += add;
    kept++;
  }
  const body = parts.join(',');
  const head = '/* 自动生成，请勿手改：node tools/build-pos.js\n' +
    '   数据源：ECDICT(MIT, skywind3000/ECDICT) 的 WordNet 词性前缀 + 中文释义前缀 + exchange 屈折形式；\n' +
    '           kaikki-en-extract.json（Wiktionary 抽取）校正。\n' +
    "   形状：window.DR_POS = { v:1, w:{ word:'noun', ... } }；每词一个主词性，上下文消歧在 js/engine/pos.js。 */\n";
  const out = head + 'window.DR_POS={"v":1,"w":{' + body + '}};\n';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');
  const size = fs.statSync(OUT).size;
  return { kept, dropped, total: entries.length, size };
}

(async function main() {
  console.log('build-pos: ECDICT=' + ECDICT);
  const kaikki = loadKaikki();
  const { words } = await buildVotes(kaikki);
  const stat = emit(words);
  const mb = (stat.size / 1024 / 1024).toFixed(2);
  console.log('· 候选词条：' + stat.total + '，收录：' + stat.kept + '，裁剪：' + stat.dropped);
  console.log('· 输出：' + OUT + '  ' + mb + ' MB' + (stat.size > 5 * 1024 * 1024 ? '  ** 超过 5MB **' : ''));
  const sample = ['the', 'run', 'striking', 'damaged', 'deliberating', 'reached', 'thought',
    'were', 'ubiquitous', 'thirteen', 'bright', 'neither', 'report', 'increase', 'light',
    'deep-sea', 'regenerating', 'satisfied', 'organize', 'slowly', 'quickly', 'ability'];
  const dict = loadForSample();
  console.log('· 抽样：' + sample.map(w => w + '=' + (dict[w] || '—')).join('  '));
  function loadForSample() {
    const txt = fs.readFileSync(OUT, 'utf8');
    const JSONTXT = txt.replace(/^[\s\S]*?window\.DR_POS=/, '').replace(/;\s*$/, '');
    return JSON.parse(JSONTXT).w;
  }
})().catch(e => { console.error(e); process.exit(1); });
