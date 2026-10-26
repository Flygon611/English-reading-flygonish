/* 查词引擎：考试词库（首屏）+ ECDICT 兜底词典（懒加载）+ 词形还原。
   数据契约见 CONTRACT.md §3；DR_EXAM / DR_DICT 由 data/ 下脚本提供。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  var PACKS = [
    { id: 'cet4', bit: 1, zh: '四级', en: 'CET-4' },
    { id: 'cet6', bit: 2, zh: '六级', en: 'CET-6' },
    { id: 'tem4', bit: 4, zh: '专四', en: 'TEM-4' },
    { id: 'tem8', bit: 8, zh: '专八', en: 'TEM-8' },
    { id: 'ielts', bit: 16, zh: '雅思', en: 'IELTS' },
    { id: 'toefl', bit: 32, zh: '托福', en: 'TOEFL' }
  ];
  var PACK_BY_ID = {};
  PACKS.forEach(function (p) { PACK_BY_ID[p.id] = p; });

  var examMap = new Map();
  var fullMap = null;
  var formMap = null;         // 屈折形式 -> 词头（exam + full）
  var fullLoading = null;
  var initialized = false;
  var pending = [];           // 等待兜底词典的回调

  var IRREG = {
    am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
    has: 'have', had: 'have', having: 'have', does: 'do', did: 'do', done: 'do', doing: 'do',
    went: 'go', gone: 'go', goes: 'go', said: 'say', made: 'make', took: 'take', taken: 'take',
    came: 'come', saw: 'see', seen: 'see', knew: 'know', known: 'know', got: 'get', gotten: 'get',
    gave: 'give', given: 'give', found: 'find', thought: 'think', told: 'tell', became: 'become',
    shown: 'show', felt: 'feel', brought: 'bring', began: 'begin', begun: 'begin', kept: 'keep',
    held: 'hold', wrote: 'write', written: 'write', stood: 'stand', heard: 'hear', meant: 'mean',
    met: 'meet', ran: 'run', paid: 'pay', sat: 'sit', spoke: 'speak', spoken: 'speak',
    lay: 'lie', lain: 'lie', led: 'lead', grew: 'grow', grown: 'grow', lost: 'lose',
    fell: 'fall', fallen: 'fall', sent: 'send', built: 'build', understood: 'understand',
    drew: 'draw', drawn: 'draw', broke: 'break', broken: 'break', spent: 'spend', rose: 'rise',
    risen: 'rise', drove: 'drive', driven: 'drive', bought: 'buy', wore: 'wear', worn: 'wear',
    chose: 'choose', chosen: 'choose', sought: 'seek', threw: 'throw', thrown: 'throw',
    caught: 'catch', dealt: 'deal', won: 'win', forgot: 'forget', forgotten: 'forget',
    ate: 'eat', eaten: 'eat', taught: 'teach', sold: 'sell', fought: 'fight', flew: 'fly',
    flown: 'fly', slept: 'sleep', drank: 'drink', drunk: 'drink', sang: 'sing', sung: 'sing',
    swam: 'swim', swum: 'swim', rode: 'ride', ridden: 'ride', shot: 'shoot', woke: 'wake',
    woken: 'wake', hid: 'hide', hidden: 'hide', bit: 'bite', bitten: 'bite', blew: 'blow',
    blown: 'blow', burnt: 'burn', fed: 'feed', fled: 'flee', hung: 'hang', lent: 'lend',
    lit: 'light', proven: 'prove', shook: 'shake', shaken: 'shake', shone: 'shine', smelt: 'smell',
    stole: 'steal', stolen: 'steal', struck: 'strike', swore: 'swear', sworn: 'swear',
    swept: 'sweep', tore: 'tear', torn: 'tear', wept: 'weep', bore: 'bear', borne: 'bear',
    beaten: 'beat', bent: 'bend', bound: 'bind', bred: 'breed', dug: 'dig', dreamt: 'dream',
    froze: 'freeze', frozen: 'freeze', ground: 'grind', knelt: 'kneel', laid: 'lay',
    mistook: 'mistake', mistaken: 'mistake', overcame: 'overcome', rebuilt: 'rebuild',
    sank: 'sink', sunk: 'sink', slid: 'slide', spat: 'spit', spun: 'spin', sprang: 'spring',
    stuck: 'stick', stung: 'sting', stank: 'stink', swollen: 'swell', trod: 'tread',
    underwent: 'undergo', wove: 'weave', withdrew: 'withdraw', withdrawn: 'withdraw',
    children: 'child', feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose',
    leaves: 'leaf', knives: 'knife', wives: 'wife', halves: 'half', wolves: 'wolf',
    shelves: 'shelf', thieves: 'thief', selves: 'self', elves: 'elf', criteria: 'criterion',
    phenomena: 'phenomenon', analyses: 'analysis', crises: 'crisis', theses: 'thesis',
    hypotheses: 'hypothesis', data: 'datum', media: 'medium',
    better: 'good', best: 'good', worse: 'bad', worst: 'bad', further: 'far', farther: 'far'
  };

  var CONTRACTIONS = {
    "isn't": 'be', "aren't": 'be', "wasn't": 'be', "weren't": 'be',
    "don't": 'do', "doesn't": 'do', "didn't": 'do', "can't": 'can', cannot: 'can',
    "couldn't": 'could', "won't": 'will', "wouldn't": 'would', "shouldn't": 'should',
    "mustn't": 'must', "needn't": 'need', "haven't": 'have', "hasn't": 'have',
    "hadn't": 'have', "i'll": 'will', "i'm": 'be', "i've": 'have', "i'd": 'would',
    "you're": 'be', "you'll": 'will', "you've": 'have', "you'd": 'would',
    "he's": 'be', "she's": 'be', "it's": 'be', "that's": 'be', "there's": 'be',
    "we're": 'be', "we'll": 'will', "we've": 'have', "they're": 'be', "they'll": 'will',
    "they've": 'have', "what's": 'be', "let's": 'let', "who's": 'be', "where's": 'be',
    "could've": 'could', "should've": 'should', "would've": 'would', "might've": 'might',
    "must've": 'must'
  };

  function norm(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase().replace(/\u2019/g, "'").trim();
    s = s.replace(/^[^a-z]+/, '').replace(/[^a-z']+$/, '');
    return s;
  }

  function entryFromExam(row) {
    return {
      w: row[0], ipa: row[1] || '', zh: row[2] || '',
      ex: row[3] || '', exZh: row[4] || '',
      mask: row[5] || 0, lvl: row[6] || 1,
      forms: row[7] ? String(row[7]).split(/\s+/).filter(Boolean) : [],
      rank: 0, source: 'exam'
    };
  }
  function entryFromFull(row) {
    return {
      w: row[0], ipa: row[1] || '', zh: row[2] || '',
      ex: '', exZh: '',
      mask: row[3] || 0, lvl: 1,
      forms: row[4] ? String(row[4]).split(/\s+/).filter(Boolean) : [],
      rank: row[5] || 0, source: 'full'
    };
  }

  function packsOf(entry) {
    return PACKS.filter(function (p) { return entry.mask & p.bit; }).map(function (p) { return p.id; });
  }
  function decorate(entry) {
    if (!entry) return null;
    entry.packs = packsOf(entry);
    return entry;
  }

  function init() {
    if (initialized) return;
    initialized = true;
    var E = window.DR_EXAM;
    if (E && Array.isArray(E.words)) {
      for (var i = 0; i < E.words.length; i++) {
        var e = entryFromExam(E.words[i]);
        var k = norm(e.w);
        if (k && !examMap.has(k)) examMap.set(k, e);
      }
    }
    buildFormMap();
  }

  function buildFormMap() {
    formMap = new Map();
    var add = function (entry) {
      for (var i = 0; i < entry.forms.length; i++) {
        var f = norm(entry.forms[i]);
        if (f && f !== norm(entry.w) && !formMap.has(f)) formMap.set(f, norm(entry.w));
      }
    };
    examMap.forEach(add);
    if (fullMap) fullMap.forEach(add);
    for (var k in d2Maps) { if (Object.prototype.hasOwnProperty.call(d2Maps, k)) d2Maps[k].forEach(add); }
  }

  function ensureFull() {
    if (fullMap) return Promise.resolve();
    if (fullLoading) return fullLoading;
    fullLoading = new Promise(function (resolve) {
      var done = function () {
        fullMap = new Map();
        var D = window.DR_DICT;
        if (D && Array.isArray(D.words)) {
          for (var i = 0; i < D.words.length; i++) {
            var e = entryFromFull(D.words[i]);
            var k = norm(e.w);
            if (k && !fullMap.has(k)) fullMap.set(k, e);
          }
        }
        buildFormMap();
        while (pending.length) {
          try { pending.shift()(); } catch (e) { console.warn(e); }
        }
        resolve();
      };
      if (window.DR_DICT) { done(); return; }
      var s = document.createElement('script');
      s.src = 'js/data/dict.js';
      s.async = true;
      s.onload = done;
      s.onerror = function () {
        console.warn('兜底词典加载失败：js/data/dict.js');
        resolve();
      };
      document.head.appendChild(s);
    });
    return fullLoading;
  }
  function hasFull() { return !!fullMap; }
  function onFull(fn) { if (fullMap) { fn(); return; } pending.push(fn); }

  /* ---------- 扩展层：按首字母分桶，查不到才注入对应 <script> ---------- */
  var d2Maps = Object.create(null);      // letter -> Map
  var d2Loading = Object.create(null);   // letter -> Promise

  function bucketLetter(low) {
    var ch = String(low || '').charAt(0);
    return /[a-z]/.test(ch) ? ch : '_';
  }

  function ingestBucket(letter) {
    if (d2Maps[letter]) return;
    var D = window.DR_D2 && window.DR_D2[letter];
    var map = new Map();
    if (Array.isArray(D)) {
      for (var i = 0; i < D.length; i++) {
        var e = entryFromFull(D[i]);
        var k = norm(e.w);
        if (k && !map.has(k)) map.set(k, e);
      }
    }
    d2Maps[letter] = map;
    buildFormMap();
  }

  function ensureBucket(letter) {
    if (d2Maps[letter]) return Promise.resolve();
    if (d2Loading[letter]) return d2Loading[letter];
    d2Loading[letter] = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'js/data/d2/d2-' + letter + '.js';
      s.async = true;
      s.onload = function () { ingestBucket(letter); resolve(); };
      s.onerror = function () {
        console.warn('扩展词库加载失败：js/data/d2/d2-' + letter + '.js');
        d2Maps[letter] = new Map();
        resolve();
      };
      document.head.appendChild(s);
    });
    return d2Loading[letter];
  }

  /* 同步查不到时用：先确保兜底词典，再按首字母补一个桶，再试一次 */
  function resolveAsync(raw) {
    var low = norm(raw);
    if (!low) return Promise.resolve(null);
    return ensureFull().then(function () {
      var hit = resolve(raw);
      if (hit) return hit;
      return ensureBucket(bucketLetter(low)).then(function () { return resolve(raw); });
    });
  }

  function lemmaCandidates(w) {
    var out = [];
    var add = function (x) { if (x && x.length > 1 && x !== w && out.indexOf(x) < 0) out.push(x); };
    var dedupe = function (x) { return /([b-df-hj-np-tv-z])\1$/.test(x) ? x.slice(0, -1) : ''; };
    if (IRREG[w]) add(IRREG[w]);
    if (CONTRACTIONS[w]) add(CONTRACTIONS[w]);
    if (w.length > 4 && w.slice(-3) === 'ies') { add(w.slice(0, -3) + 'y'); add(w.slice(0, -1)); }
    if (w.length > 4 && w.slice(-3) === 'ves') { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); }
    if (w.length > 3 && w.slice(-2) === 'es') { add(w.slice(0, -2)); add(w.slice(0, -1)); }
    if (w.length > 2 && w.slice(-1) === 's') add(w.slice(0, -1));
    if (w.length > 4 && w.slice(-3) === 'ied') add(w.slice(0, -3) + 'y');
    if (w.length > 4 && w.slice(-2) === 'ed') {
      var b = w.slice(0, -2);
      add(b + 'e'); add(b); add(dedupe(b)); add(w.slice(0, -1));
    }
    if (w.length > 5 && w.slice(-4) === 'ying') add(w.slice(0, -4) + 'ie');
    if (w.length > 5 && w.slice(-3) === 'ing') {
      var c = w.slice(0, -3);
      add(c + 'e'); add(c); add(dedupe(c)); add(w.slice(0, -4) + 'e');
    }
    if (w.length > 4 && w.slice(-3) === 'ier') add(w.slice(0, -3) + 'y');
    if (w.length > 5 && w.slice(-4) === 'iest') add(w.slice(0, -4) + 'y');
    if (w.length > 4 && w.slice(-2) === 'er') {
      var d = w.slice(0, -2);
      add(d + 'e'); add(d); add(dedupe(d)); add(w.slice(0, -1));
    }
    if (w.length > 5 && w.slice(-3) === 'est') {
      var f = w.slice(0, -3);
      add(f + 'e'); add(f); add(dedupe(f)); add(w.slice(0, -2));
    }
    if (w.length > 4 && w.slice(-3) === 'ily') add(w.slice(0, -3) + 'y');
    if (w.length > 4 && w.slice(-2) === 'ly') add(w.slice(0, -2));
    return out;
  }

  function direct(w) {
    if (examMap.has(w)) return examMap.get(w);
    if (fullMap && fullMap.has(w)) return fullMap.get(w);
    var m = d2Maps[bucketLetter(w)];
    if (m && m.has(w)) return m.get(w);
    return null;
  }

  function resolve(raw) {
    init();
    var low = norm(raw);
    if (!low) return null;
    if (!formMap) buildFormMap();
    var hit = baseResolve(low);
    if (!hit) {
      var base = '';
      if (/['\u2019]s$/.test(low) && low.length > 3) base = low.slice(0, -2);
      else if (/s['\u2019]$/.test(low) && low.length > 2) base = low.slice(0, -1);
      if (base) {
        var bh = baseResolve(base);
        if (bh) hit = { entry: bh.entry, matched: bh.matched, via: 'possessive' };
      }
    }
    if (!hit) return null;
    return { entry: decorate(hit.entry), raw: raw, matched: hit.matched, via: hit.via };
  }

  /* 直接命中 / 屈折形式 → 词头 / 词形规则还原；不含所有格 */
  function baseResolve(low) {
    var hit = direct(low);
    if (hit) return { entry: hit, matched: low, via: 'exact' };
    if (formMap && formMap.has(low)) {
      var base = formMap.get(low);
      var e2 = direct(base);
      if (e2) return { entry: e2, matched: base, via: 'form' };
    }
    var cands = lemmaCandidates(low);
    for (var i = 0; i < cands.length; i++) {
      var e3 = direct(cands[i]);
      if (e3) return { entry: e3, matched: cands[i], via: 'lemma' };
    }
    return null;
  }

  function lookup(raw) {
    var r = resolve(raw);
    return r ? r.entry : null;
  }

  function search(q, limit) {
    init();
    var s = norm(q) || String(q || '').toLowerCase().trim();
    if (!s) return [];
    limit = limit || 40;
    var out = [];
    var seen = Object.create(null);
    var collect = function (map) {
      if (!map) return;
      map.forEach(function (e, k) {
        if (out.length >= limit * 4) return;
        if (k.indexOf(s) === 0 || k.indexOf(' ' + s) >= 0) {
          if (seen[k]) return;
          seen[k] = 1;
          out.push(decorate(e));
        }
      });
    };
    collect(examMap);
    collect(fullMap);
    out.sort(function (a, b) {
      var sa = a.w.toLowerCase() === s ? 0 : (a.w.toLowerCase().indexOf(s) === 0 ? 1 : 2);
      var sb = b.w.toLowerCase() === s ? 0 : (b.w.toLowerCase().indexOf(s) === 0 ? 1 : 2);
      if (sa !== sb) return sa - sb;
      if (a.source !== b.source) return a.source === 'exam' ? -1 : 1;
      var ra = a.rank || 1e9, rb = b.rank || 1e9;
      if (ra !== rb) return ra - rb;
      return a.w.localeCompare(b.w);
    });
    return out.slice(0, limit);
  }

  function stats() {
    init();
    var d2 = 0;
    for (var k in d2Maps) { if (Object.prototype.hasOwnProperty.call(d2Maps, k)) d2 += d2Maps[k].size; }
    return { exam: examMap.size, full: fullMap ? fullMap.size : 0, fullLoaded: !!fullMap, extra: d2, extraBuckets: Object.keys(d2Maps).length };
  }

  /* 未收录词的词缀提示 */
  function affixHints(word) {
    var A = window.DR_AFFIX;
    if (!A || !Array.isArray(A.items)) return [];
    var w = norm(word), hits = [];
    A.items.forEach(function (it) {
      var a = String(it.a || '').toLowerCase();
      if (!a) return;
      var core = a.replace(/^[-]+|[-]+$/g, '');
      if (!core) return;
      if (a.charAt(0) === '-' && a.slice(-1) === '-') { if (w.indexOf(core) > 0) hits.push(it); }
      else if (a.slice(-1) === '-') { if (w.indexOf(core) === 0 && w.length > core.length + 2) hits.push(it); }
      else if (a.charAt(0) === '-') { if (w.slice(-core.length) === core && w.length > core.length + 2) hits.push(it); }
      else if (w.indexOf(core) >= 0) hits.push(it);
    });
    return hits.slice(0, 3);
  }

  function examEntries() {
    init();
    var out = [];
    examMap.forEach(function (e) { out.push(decorate(e)); });
    return out;
  }
  function fullEntries() {
    init();
    var out = [];
    if (fullMap) fullMap.forEach(function (e) { out.push(decorate(e)); });
    return out;
  }

  DR.dict = {
    PACKS: PACKS, PACK_BY_ID: PACK_BY_ID, examEntries: examEntries, fullEntries: fullEntries,
    init: init, norm: norm, lookup: lookup, resolve: resolve, resolveAsync: resolveAsync,
    search: search, ensureFull: ensureFull, hasFull: hasFull, onFull: onFull,
    ensureBucket: ensureBucket, stats: stats,
    packsOf: packsOf, affixHints: affixHints, lemmaCandidates: lemmaCandidates
  };
})();
