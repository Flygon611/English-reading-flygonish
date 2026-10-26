/* 复习出题：多种题型 + 自动生成的混淆项（拼写相近 / 释义相近）。
   纯数据层，不碰 DOM；notebook 视图消费这里的题目对象。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  var CACHE = { pool: null, entries: null, bigram: null, zhIndex: null, exam: null };
  var ZH_STOP = {};
  ('的了地得是在有和与或等这那个一些可下上中为对以于而及着过把被让从向到就都还也很更最不没有我你他她它我们你们他们'
  ).split('').forEach(function (c) { ZH_STOP[c] = 1; });

  function norm(w) {
    return String(w == null ? '' : w).toLowerCase().replace(/\u2019/g, "'").replace(/[^a-z'-]/g, '');
  }
  function zhCore(zh) {
    return String(zh == null ? '' : zh)
      .replace(/\[[^\]]*\]/g, '')
      .replace(/[A-Za-z]+\./g, '')
      .replace(/[^\u4e00-\u9fff]/g, '');
  }
  function defText(zh, max) {
    var s = String(zh == null ? '' : zh).replace(/\s+/g, ' ').trim();
    if (max && s.length > max) s = s.slice(0, max - 1) + '…';
    return s;
  }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function uniq(arr) {
    var out = [], seen = {};
    arr.forEach(function (x) { if (x != null && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  function bigrams(w) {
    var s = '^' + w + '$', out = {}, list = [];
    for (var i = 0; i < s.length - 1; i++) {
      var g = s.slice(i, i + 2);
      if (!out[g]) { out[g] = 1; list.push(g); }
    }
    return list;
  }

  /* 编辑距离（Damerau，带 max 提前退出） */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    if (a === b) return 0;
    var prev2 = [], prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
        }
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }

  function ensureIndex() {
    if (CACHE.entries) return;
    var exam = DR.dict.examEntries ? DR.dict.examEntries() : [];
    var full = DR.dict.fullEntries ? DR.dict.fullEntries() : [];
    var seen = {}, pool = [];
    exam.concat(full).forEach(function (e) {
      var w = norm(e.w);
      if (!w || seen[w] || !e.zh) return;
      seen[w] = 1;
      pool.push(e);
    });
    var bigram = new Map();
    pool.forEach(function (e, i) {
      var w = norm(e.w);
      if (!w) return;
      bigrams(w).forEach(function (g) {
        if (!bigram.has(g)) bigram.set(g, []);
        bigram.get(g).push(i);
      });
    });
    var zhIndex = new Map();
    exam.forEach(function (e, i) {
      var core = zhCore(e.zh);
      if (!core) return;
      var seenCh = {};
      for (var k = 0; k < core.length; k++) {
        var ch = core.charAt(k);
        if (seenCh[ch] || ZH_STOP[ch]) continue;
        seenCh[ch] = 1;
        if (!zhIndex.has(ch)) zhIndex.set(ch, []);
        zhIndex.get(ch).push(i);
      }
    });
    CACHE.pool = pool;
    CACHE.entries = pool;
    CACHE.bigram = bigram;
    CACHE.zhIndex = zhIndex;
    CACHE.exam = exam;
  }

  /* 拼写相近：共享 ≥2 个 bigram + 编辑距离 ≤2；考试词优先，同长度优先 */
  function spellingNeighbors(word, limit) {
    ensureIndex();
    var w = norm(word);
    if (!w || w.length < 2) return [];
    var scores = {};
    bigrams(w).forEach(function (g) {
      (CACHE.bigram.get(g) || []).forEach(function (i) { scores[i] = (scores[i] || 0) + 1; });
    });
    var cand = [];
    Object.keys(scores).forEach(function (k) {
      if (scores[k] < 2) return;
      var e = CACHE.entries[+k];
      if (!e || !e.zh) return;
      var cw = norm(e.w);
      if (!cw || cw === w || Math.abs(cw.length - w.length) > 2) return;
      var d = editDistance(w, cw, 2);
      if (d > 2) return;
      cand.push({
        e: e, d: d, len: Math.abs(cw.length - w.length),
        exam: e.source === 'exam' ? 0 : 1,
        rank: e.rank || 1e9
      });
    });
    cand.sort(function (a, b) {
      if (a.d !== b.d) return a.d - b.d;
      if (a.len !== b.len) return a.len - b.len;
      if (a.exam !== b.exam) return a.exam - b.exam;
      return a.rank - b.rank;
    });
    var out = [], seen = {};
    cand.forEach(function (c) {
      var k = norm(c.e.w);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(c.e);
    });
    if (out.length < limit) {
      var extra = CACHE.entries.filter(function (e) {
        var cw = norm(e.w);
        return cw && cw !== w && Math.abs(cw.length - w.length) <= 1 && cw.charAt(0) === w.charAt(0);
      });
      shuffle(extra);
      for (var i = 0; i < extra.length && out.length < limit; i++) {
        var k2 = norm(extra[i].w);
        if (seen[k2] || !extra[i].zh) continue;
        seen[k2] = 1;
        out.push(extra[i]);
      }
    }
    return out.slice(0, limit);
  }

  /* 释义相近：中文核心字重合 ≥2；同词性/同词头首字加权 */
  function meaningNeighbors(item, limit) {
    ensureIndex();
    var core = zhCore(item.zh);
    if (core.length < 2) return [];
    var counts = {};
    var seenCh = {};
    for (var k = 0; k < core.length; k++) {
      var ch = core.charAt(k);
      if (seenCh[ch] || ZH_STOP[ch]) continue;
      seenCh[ch] = 1;
      (CACHE.zhIndex.get(ch) || []).forEach(function (i) { counts[i] = (counts[i] || 0) + 1; });
    }
    var base = norm(item.lemma || item.w);
    var basePos = String(item.zh || '').split(/\s+/)[0].replace(/\..*/, '');
    var ownZh = zhCore(item.zh);
    var cand = [];
    Object.keys(counts).forEach(function (k) {
      var e = CACHE.exam[+k];
      if (!e || !e.zh) return;
      var ew = norm(e.w);
      if (!ew || ew === base) return;
      var ez = zhCore(e.zh);
      if (!ez || ez === ownZh || ownZh.indexOf(ez) === 0 || ez.indexOf(ownZh) === 0) return;
      var ePos = String(e.zh || '').split(/\s+/)[0].replace(/\..*/, '');
      var score = counts[k] * 2;
      if (ePos && basePos && ePos === basePos) score += 3;
      if (ez.charAt(0) === ownZh.charAt(0)) score += 2;
      if (ez.length > 24) score -= 1;
      cand.push({ e: e, score: score });
    });
    cand.sort(function (a, b) { return b.score - a.score; });
    return cand.slice(0, limit).map(function (x) { return x.e; });
  }

  function posOf(zh) {
    var m = /^s*(n|vt|vi|v|adj|a|adv|ad|aux|prep|conj|pron|num|art|int)./i.exec(String(zh || ''));
    if (!m) return '';
    var p = m[1].toLowerCase();
    if (p === 'vt' || p === 'vi' || p === 'v') return 'v';
    if (p === 'a') return 'adj';
    if (p === 'ad') return 'adv';
    return p;
  }
  function zhBigrams(core) {
    var out = {}, list = [];
    for (var i = 0; i < core.length - 1; i++) {
      var g = core.slice(i, i + 2);
      if (!out[g]) { out[g] = 1; list.push(g); }
    }
    return list;
  }
  function similarMeaningZh(a, b) {
    var ca = zhCore(a), cb = zhCore(b);
    if (!ca || !cb) return false;
    if (ca === cb) return true;
    var ga = zhBigrams(ca), gb = zhBigrams(cb), shared = 0;
    for (var i = 0; i < ga.length; i++) if (gb.indexOf(ga[i]) >= 0) shared++;
    return shared >= 2;
  }
  function samePosWords(item, limit) {
    ensureIndex();
    var p = posOf(item.zh);
    var base = norm(item.w);
    var arr = (CACHE.exam || []).filter(function (e) {
      if (!e.zh || norm(e.w) === base) return false;
      if (p && posOf(e.zh) !== p) return false;
      return /^[a-z]{2,18}$/i.test(e.w);
    });
    shuffle(arr);
    var bFirst = base.charAt(0);
    arr.sort(function (a, b) {
      var fa = norm(a.w).charAt(0) === bFirst ? 0 : 1;
      var fb = norm(b.w).charAt(0) === bFirst ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return Math.abs(norm(a.w).length - base.length) - Math.abs(norm(b.w).length - base.length);
    });
    return arr.slice(0, limit);
  }

  function packFilter(entry, item) {
    var a = entry.packs || [], b = item.packs || [];
    for (var i = 0; i < b.length; i++) if (a.indexOf(b[i]) >= 0) return true;
    return false;
  }

  function meaningOptions(item) {
    var correct = defText(item.zh, 72);
    var dists = meaningNeighbors(item, 14)
      .filter(function (e) { return !similarMeaningZh(item.zh, e.zh); })
      .map(function (e) { return defText(e.zh, 72); })
      .filter(function (t) { return t && t !== correct; });
    var opts = uniq([correct].concat(dists)).slice(0, 4);
    if (opts.length < 4) {
      var extra = samePosWords(item, 30).map(function (e) { return defText(e.zh, 72); })
        .filter(function (t) { return t && t !== correct && !similarMeaningZh(item.zh, t); });
      opts = uniq(opts.concat(extra)).slice(0, 4);
    }
    return buildOptions(opts.map(function (t) { return { text: t, correct: t === correct }; }));
  }

  function wordOptions(item, blankCorrect, useForms) {
    var correct = blankCorrect || item.w;
    var base = item.lemma || item.w;
    var p = posOf(item.zh);
    var neigh = spellingNeighbors(base, 12);
    var same = function (e) { return !p || posOf(e.zh) === p; };
    var family = useForms ? (item.forms || []).filter(function (f) { return norm(f) !== norm(correct); }) : [];
    var sameDists = neigh.filter(same).map(function (e) { return e.w; });
    var opts = uniq([correct].concat(family).concat(sameDists)).slice(0, 4);
    if (opts.length < 4) {
      var extra = samePosWords(item, 40).map(function (e) { return e.w; }).filter(function (w) { return norm(w) !== norm(correct); });
      opts = uniq(opts.concat(extra)).slice(0, 4);
    }
    if (opts.length < 4) {
      var others = neigh.map(function (e) { return e.w; }).filter(function (w) { return norm(w) !== norm(correct) && w.length <= 18 && /^[a-z]+$/i.test(w); });
      opts = uniq(opts.concat(others)).slice(0, 4);
    }
    if (opts.length < 4) {
      var extra2 = shuffle((CACHE.entries || []).filter(function (e) {
        return e.zh && norm(e.w) !== norm(correct) && Math.abs(norm(e.w).length - norm(correct).length) <= 2;
      })).slice(0, 20).map(function (e) { return e.w; });
      opts = uniq(opts.concat(extra2)).slice(0, 4);
    }
    return buildOptions(opts.map(function (w) { return { text: w, correct: norm(w) === norm(correct) }; }));
  }

  function buildOptions(list) {
    var arr = list.slice();
    // 确保正好一个正确答案；没有正确答案则把第一项标成正确（防御）
    var corrects = arr.filter(function (o) { return o.correct; });
    if (!corrects.length && arr.length) arr[0].correct = true;
    shuffle(arr);
    return arr;
  }

  /* 语境填空：找出含该词的句子并挖空 */
  function clozeOf(item) {
    var ctx = (item.contexts && item.contexts[0] && item.contexts[0].text) || '';
    if (!ctx) return null;
    var forms = uniq([item.w, item.lemma].concat(item.forms || []).filter(Boolean));
    var hit = '';
    for (var i = 0; i < forms.length; i++) {
      var f = String(forms[i]);
      if (f.length < 2) continue;
      var re = new RegExp('\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      var m = re.exec(ctx);
      if (m) { hit = m[0]; break; }
    }
    if (!hit) return null;
    var blanked = ctx.replace(new RegExp('\\b' + hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), '____');
    return { sentence: blanked, full: ctx, surface: hit };
  }

  function flashOf(item) {
    return { type: 'flash', item: item };
  }

  var AUX_WORDS = {};
  ('be am is are was were been being do does did done have has had having will would shall should can could may might must not no yes '
  ).split(' ').forEach(function (w) { AUX_WORDS[w] = 1; });

  function meaningOf(item) {
    if (!String(item.zh || '').trim()) return null;
    if (norm(item.w).length <= 2) return null;
    if (AUX_WORDS[norm(item.w)] || /^s*aux./i.test(String(item.zh))) return null;
    var opts = meaningOptions(item);
    if (opts.length < 3 || opts.filter(function (o) { return !o.correct; }).length < 2) return null;
    return {
      type: 'meaning',
      item: item,
      word: item.w,
      ipa: item.ipa || '',
      prompt: item.w,
      options: opts,
      answerText: defText(item.zh, 120),
      hint: '选出这个词的中文释义'
    };
  }

  function wordOf(item) {
    if (!String(item.zh || '').trim()) return null;
    return {
      type: 'word',
      item: item,
      prompt: defText(item.zh, 160),
      options: wordOptions(item),
      answerText: item.w,
      hint: '选出对应的英文单词'
    };
  }

  function clozeQ(item) {
    var c = clozeOf(item);
    if (!c) return null;
    return {
      type: 'cloze',
      item: item,
      prompt: c.sentence,
      fullContext: c.full,
      options: wordOptions(item, c.surface, true),
      answerText: c.surface,
      hint: '根据语境选出最合适的词'
    };
  }

  function spellQ(item) {
    var answer = norm(item.lemma || item.w);
    if (!answer || answer.length < 3 || answer.length > 20) return null;
    if (!/^[a-z][a-z'-]+$/.test(answer)) return null;
    return {
      type: 'spell',
      item: item,
      prompt: defText(item.zh, 160),
      answerText: item.w,
      accept: uniq([norm(item.w), answer].concat((item.forms || []).map(norm))).filter(Boolean),
      hint: '共 ' + answer.length + ' 个字母，首字母 ' + answer.charAt(0).toUpperCase() + ' · 输入后按 Enter'
    };
  }

  function audioQ(item) {
    if (!DR.tts || !DR.tts.hasVoice || !DR.tts.hasVoice()) return null;
    return {
      type: 'audio',
      item: item,
      prompt: '听发音，选出你听到的单词',
      audioText: item.w,
      options: wordOptions(item),
      answerText: item.w,
      hint: '可能的话戴上耳机；没有听清可以再点一次'
    };
  }

  function possible(type, item) {
    if (type === 'flash') return true;
    if (type === 'meaning') return !!String(item.zh || '').trim();
    if (type === 'word') return !!String(item.zh || '').trim();
    if (type === 'cloze') return !!clozeOf(item);
    if (type === 'spell') return !!spellQ(item);
    if (type === 'audio') return !!(DR.tts && DR.tts.hasVoice && DR.tts.hasVoice());
    return false;
  }

  function hashKey(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function mixType(item, idx) {
    var all = ['meaning', 'word', 'cloze', 'spell'];
    if (DR.tts && DR.tts.hasVoice && DR.tts.hasVoice()) all.push('audio');
    var avail = all.filter(function (t) { return possible(t, item); });
    if (!avail.length) return 'flash';
    return avail[(idx + hashKey(item.key || item.w || '')) % avail.length];
  }

  function build(items, mode) {
    var out = [];
    items.forEach(function (it, idx) {
      var type = mode === 'mix' ? mixType(it, idx) : mode;
      var q = null;
      if (type === 'flash' || type === 'flashcard') q = flashOf(it);
      else if (type === 'meaning') q = meaningOf(it);
      else if (type === 'word') q = wordOf(it);
      else if (type === 'cloze') q = clozeQ(it);
      else if (type === 'spell') q = spellQ(it);
      else if (type === 'audio') q = audioQ(it);
      out.push(q || flashOf(it));
    });
    return out;
  }

  DR.quiz = {
    build: build,
    flashOf: flashOf,
    spellingNeighbors: spellingNeighbors,
    meaningNeighbors: meaningNeighbors,
    possible: possible,
    editDistance: editDistance,
    defText: defText
  };
})();
