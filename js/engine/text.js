/* 文本切分：段落 / 句子 / 单词 token。全站唯一 tokenizer，解析引擎与 UI 共用。
   契约见 CONTRACT.md §4.1，已冻结：token 覆盖整个输入、无缝隙，s/e 为原文偏移。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  var WORD_SRC = "[A-Za-z0-9]+(?:['\u2019][A-Za-z]+)*(?:-[A-Za-z]+)*";
  var RE_WORD = new RegExp(WORD_SRC, 'g');
  var RE_WORD_ONE = new RegExp('^' + WORD_SRC);

  function gapTokens(out, chunk, offset) {
    var i = 0;
    while (i < chunk.length) {
      var rest = chunk.slice(i);
      var m = /^\s+/.exec(rest);
      if (m) {
        out.push({ t: m[0], s: offset + i, e: offset + i + m[0].length, k: 's' });
        i += m[0].length;
        continue;
      }
      var m2 = /^[^\sA-Za-z]+/.exec(rest);
      var len = m2 ? m2[0].length : 1;
      out.push({ t: chunk.substr(i, len), s: offset + i, e: offset + i + len, k: 'p' });
      i += len;
    }
  }

  function tokenize(text) {
    var s = text == null ? '' : String(text);
    var out = [];
    var last = 0;
    var m;
    RE_WORD.lastIndex = 0;
    while ((m = RE_WORD.exec(s))) {
      if (m.index > last) gapTokens(out, s.slice(last, m.index), last);
      var hasDigit = /\d/.test(m[0]);
      var tok = { t: m[0], s: m.index, e: m.index + m[0].length, k: hasDigit ? 'n' : 'w' };
      if (!hasDigit) tok.w = m[0].toLowerCase();   // 纯词汇 token 才可查询/参与词性分析
      out.push(tok);
      last = m.index + m[0].length;
    }
    if (last < s.length) gapTokens(out, s.slice(last), last);
    return out;
  }

  function words(text) {
    return tokenize(text).filter(function (tk) { return tk.k === 'w'; });
  }

  /* 句末缩写表：这些点不断句（大小写不敏感，去掉末尾点比较） */
  var ABBR = {};
  ('Mr Mrs Ms Dr Prof St Jr Sr vs etc Fig No Inc Ltd Co Corp Gen Gov Sen Rep Rev Hon ' +
    'Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Approx Dept Univ Assn Bros ' +
    'a.m p.m e.g i.e cf viz al U.S U.K U.N').split(' ').forEach(function (a) { ABBR[a.toLowerCase()] = 1; });

  function isAbbrev(before) {
    if (!before) return false;
    var tail = before.match(/([A-Za-z.]+)$/);
    if (!tail) return false;
    var w = tail[1].replace(/\./g, '');
    if (!w) return false;
    if (w.length === 1) return true;                       // 姓名首字母 J. K. Rowling
    if (ABBR[w.toLowerCase()]) return true;
    if (/\b(?:[A-Za-z]\.){2,}$/.test(before)) return true; // U.S. / e.g.
    if (/[A-Za-z](\.[A-Za-z])+$/.test(before)) return true; // p.m / a.k.a / i.e
    return false;
  }

  function splitSentences(text) {
    var s = text == null ? '' : String(text).replace(/\r\n?/g, '\n');
    var out = [];
    var start = 0;
    var i = 0;
    var n = s.length;
    while (i < n) {
      var c = s[i];
      var boundary = false;
      if (c === '\n') {
        boundary = true;
        i += 1;
      } else if (c === '.' || c === '!' || c === '?' || c === '\u2026') {
        if (c === '.' || c === '\u2026') {
          if (i > 0 && /\d/.test(s[i - 1]) && i + 1 < n && /\d/.test(s[i + 1])) { i += 1; continue; }
          if (c === '.' && isAbbrev(s.slice(Math.max(0, start), i))) { i += 1; continue; }
        }
        var j = i + 1;
        while (j < n && /[.!?\u2026]/.test(s[j])) j += 1;       // ?! / ... 合并
        while (j < n && /["'\u2019\u201d)\]]/.test(s[j])) j += 1; // 收尾引号括号
        if (j >= n || /\s/.test(s[j])) { boundary = true; i = j; } else { i = j; continue; }
      } else {
        i += 1;
        continue;
      }
      addSentence(out, s, start, i);
      start = i;
    }
    if (start < n) addSentence(out, s, start, n);
    return out;
  }

  function addSentence(out, s, from, to) {
    while (from < to && /\s/.test(s[from])) from += 1;
    while (to > from && /\s/.test(s[to - 1])) to -= 1;
    if (to <= from) return;
    var body = s.slice(from, to);
    if (!/[A-Za-z0-9]/.test(body)) return;
    out.push({ text: body, start: from, end: to });
  }

  function paragraphs(text) {
    var s = text == null ? '' : String(text).replace(/\r\n?/g, '\n');
    var blocks = s.split(/\n[ \t]*\n+/).map(function (b) { return b.trim(); }).filter(Boolean);
    if (!blocks.length) return [];
    if (blocks.length === 1) {
      var lines = blocks[0].split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (lines.length > 1) return lines;
      return lines.length ? lines : [];
    }
    return blocks.map(function (b) { return b.replace(/\s*\n\s*/g, ' ').trim(); }).filter(Boolean);
  }

  /* 阅读统计：词数、句数、字母词去重等 */
  function stats(text) {
    var toks = words(text);
    var sents = splitSentences(text);
    var uniq = Object.create(null);
    for (var i = 0; i < toks.length; i++) uniq[toks[i].w] = 1;
    return {
      chars: String(text || '').length,
      wordCount: toks.length,
      sentenceCount: sents.length,
      uniqueCount: Object.keys(uniq).length,
      sentences: sents
    };
  }

  DR.text = {
    tokenize: tokenize,
    words: words,
    splitSentences: splitSentences,
    paragraphs: paragraphs,
    stats: stats,
    WORD_RE: new RegExp(WORD_SRC, 'g')
  };
})();
