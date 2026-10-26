/* ============================================================================
 * analyze.js — DR.analyze：句子成分的规则启发式分析
 *
 * 契约见 CONTRACT.md §4.2。要点：
 *   - 只使用 DR.text.tokenize（不另写 tokenizer），tokens 与单词 token 一一对应；
 *   - 纯函数、无 DOM、不联网；file:// 下 load() 动态插入 js/data/pos-lex.js；
 *   - 输出是「自动推断」，允许出错：confidence + docs/ANALYSIS.md 说明局限。
 *
 * 分析流水线：
 *   1) 词性标注（js/engine/pos.js：功能词表 + ECDICT pos-lex 多候选 + 上下文规则）
 *   2) 分句：并列分句 / 从属分句（状语、名词性、定语）/ 非谓语短语
 *   3) 主干：主语 + 谓语 + 宾语/表语；先从主句里排除嵌套从句，再找有限动词组
 *   4) 语法点 notes + 中文 summary + 置信度 confidence
 *
 * 诚信原则：主干不可靠时宁可留空（structure 为空、confidence ≤ 0.45、
 * summary 写「未能可靠识别主干」），不硬标错。
 * ==========================================================================*/
(function () {
  'use strict';

  var DR = (window.DR = window.DR || {});

  var LEGEND = [
    { id: 'subj', zh: '主语', color: '#2A7F76', desc: '动作的发出者 / 被说明的对象' },
    { id: 'pred', zh: '谓语', color: '#B4552D', desc: '句子的核心动词（时态、语态都体现在这里）' },
    { id: 'obj', zh: '宾语', color: '#3B6FB0', desc: '动作的承受者（可有两个宾语）' },
    { id: 'comp', zh: '表语', color: '#7B57A6', desc: '系动词后面说明主语的部分' },
    { id: 'adv', zh: '状语', color: '#6B7C8A', desc: '时间、地点、原因、方式等修饰成分' },
    { id: 'attr', zh: '定语', color: '#A9752C', desc: '修饰名词的成分（形容词 / 介词短语 / 从句）' },
    { id: 'aux', zh: '助动词', color: '#8A8F98', desc: '构成时态、语态、疑问的辅助词' },
    { id: 'nonfin', zh: '非谓语', color: '#4C8C5A', desc: 'to do / doing / done 结构' },
    { id: 'mark', zh: '从句标记', color: '#9A6B4F', desc: '引导从句的连词' },
    { id: 'rel', zh: '关系词', color: '#8A7355', desc: '定语从句的关系代词 / 关系副词' },
    { id: 'conj', zh: '连词', color: '#8A8F98', desc: '并列或从属连接' },
    { id: 'prep', zh: '介词', color: '#8A8F98', desc: '介词短语的引导词' },
    { id: 'det', zh: '限定词', color: '#8A8F98', desc: '冠词 / 物主 / 指示 / 数量限定词' },
    { id: 'appos', zh: '同位语', color: '#9A6B4F', desc: '对前面名词的解释或补充' }
  ];
  var POS_ZH = {
    noun: '名词', verb: '动词', adj: '形容词', adv: '副词', prep: '介词', conj: '连词',
    pron: '代词', det: '限定词', num: '数词', aux: '助动词', modal: '情态动词',
    part: '小品词', interj: '感叹词', propn: '专有名词'
  };
  var POS_SET = { noun: 1, verb: 1, adj: 1, adv: 1, prep: 1, conj: 1, pron: 1, det: 1, num: 1, aux: 1, modal: 1, part: 1, interj: 1, propn: 1 };
  var ROLE_SET = { subj: 1, pred: 1, obj: 1, comp: 1, adv: 1, attr: 1, aux: 1, det: 1, prep: 1, conj: 1, mark: 1, rel: 1, nonfin: 1, appos: 1, '': 1 };
  var CLAUSE_TYPES = { main: 1, coord: 1, sub: 1, rel: 1, nonfinite: 1 };
  var AUX_WORD = { be: 1, am: 1, is: 1, are: 1, was: 1, were: 1, been: 1, being: 1, have: 1, has: 1, had: 1, having: 1, do: 1, does: 1, did: 1 };
  var lastTrace = null;
  var BE_WORD = { be: 1, am: 1, is: 1, are: 1, was: 1, were: 1, been: 1, being: 1 };
  var HAVE_WORD = { have: 1, has: 1, had: 1, having: 1 };
  var WH_ADV = { when: 1, where: 1, why: 1, how: 1 };
  /* 后面直接跟动词原形的动词（help improve / make him go） */
  var BARE_INF = { help: 1, helps: 1, helped: 1, make: 1, makes: 1, made: 1, let: 1, lets: 1,
    have: 1, has: 1, had: 1, see: 1, sees: 1, saw: 1, seen: 1, hear: 1, hears: 1, heard: 1,
    watch: 1, watches: 1, watched: 1, feel: 1, feels: 1, felt: 1, notice: 1, noticed: 1 };

  function lex() { return DR.pos && DR.pos.lex; }
  function h(set, w) { return !!(set && set[w]); }

  /* ---------------- 分词 + 标点辅助 ---------------- */
  function buildWords(text) {
    var raw = DR.text.tokenize(text);
    var W = [];
    var i, tk;
    var lastWord = -1;
    var after = [];
    for (i = 0; i < raw.length; i++) {
      tk = raw[i];
      if (tk.k === 'w') {
        W.push({ t: tk.t, w: tk.w, s: tk.s, e: tk.e });
        after[W.length - 1] = '';
        lastWord = W.length - 1;
      } else if (tk.k === 'p' && lastWord >= 0) {
        after[lastWord] += tk.t;
      }
    }
    return { W: W, after: after };
  }

  function hasComma(after, i) { return !!(after[i] && /[,;:—–]|\.\.\./.test(after[i])); }
  function hasSemi(after, i) { return !!(after[i] && /[;:—–]/.test(after[i])); }

  /* ---------------- 有限动词判定 ---------------- */
  function prevContent(W, i) {
    var j = i - 1;
    while (j >= 0 && (W[j].pos === 'adv' || (W[j].pos === 'part' && W[j].w === 'not'))) j--;
    return j;
  }

  function nonfiniteEvidence(W, i) {
    var L = lex();
    var w = W[i].w;
    var j = prevContent(W, i);
    if (j >= 0 && W[j].pos === 'part' && W[j].w === 'to') return true;
    if (j >= 0 && W[j].pos === 'prep') return true;
    if (j >= 0 && W[j].pos === 'det') return true;
    if (j >= 0 && W[j].pos === 'adj' && /(?:ed|ing)$/.test(w)) return true;
    if (j >= 0 && W[j].pos === 'conj' && !h(L.COORD_CONJ, W[j].w)) return true;
    /* help improve / make him go：前一个动词的宾语补足语（裸不定式） */
    if (j >= 0 && BARE_INF[W[j].w] && !/(?:ed|ing)$/.test(w)) return true;
    /* IRREG_PT + to be：previously thought to be extinct（简化定语/状语，非谓语） */
    if (h(L.IRREG_PP, w) && i + 1 < W.length && W[i + 1].pos === 'part' && W[i + 1].w === 'to' &&
      j >= 0 && (W[j].pos === 'adv' || W[j].pos === 'noun' || W[j].pos === 'propn' || W[j].pos === 'adj')) return true;
    if (/ing$/.test(w)) {
      if (j >= 0 && (h(L.BE, W[j].w) || W[j].pos === 'aux')) return false;
      return true;
    }
    if (h(L.IRREG_PP, w) && !h(L.IRREG_PAST, w)) {
      if (j >= 0 && (W[j].pos === 'aux' || h(L.HAVE, W[j].w) || h(L.BE, W[j].w))) return false;
      return true;
    }
    return false;
  }

  function isFiniteToken(W, i) {
    var p = W[i].pos;
    if (p !== 'verb' && p !== 'aux' && p !== 'modal') return false;
    return !nonfiniteEvidence(W, i);
  }

  /* 动词组：{start, end, head, auxes} */
  function verbGroupAt(W, i, to) {
    var L = lex();
    if (!isFiniteToken(W, i)) return null;
    var start = i, j = i, head = -1, auxes = [], hadAux = false;
    while (j < to) {
      var q = W[j].pos, qw = W[j].w;
      if (head >= 0) break;
      if (q === 'modal' || h(L.CONTRACT_AUX, qw) || (h(L.AUX_ANY, qw) && (q === 'aux' || j === i || hadAux))) {
        auxes.push(j); hadAux = true; j++; continue;
      }
      if (h(AUX_WORD, qw) && (q === 'aux' || !hadAux)) { auxes.push(j); hadAux = true; j++; continue; }
      if (q === 'adv' && (qw === 'not' || qw === 'never' || qw === 'already' || qw === 'also' || qw === 'just')) { j++; continue; }
      if (q === 'verb' && head < 0) { head = j; j++; continue; }
      break;
    }
    if (head < 0) {
      /* 只有助动词/系动词（助动词省略式 did not / will）：取最后一个非副词作 head */
      for (var hk = j - 1; hk >= start; hk--) {
        if (W[hk].pos !== 'adv') { head = hk; break; }
      }
      if (head < 0) head = start;
    }
    return { start: start, end: j, head: head, auxes: auxes };
  }

  /* 找有限动词组；跳过嵌套从句内部 */
  function findFiniteGroup(W, from, to, nested) {
    for (var i = from; i < to; i++) {
      var sp = nested ? inSpan(nested, i) : null;
      if (sp) { i = sp.end - 1; continue; }
      if (!isFiniteToken(W, i)) continue;
      var g = verbGroupAt(W, i, to);
      if (g) return g;
    }
    return null;
  }

  /* ---------------- 分句 ---------------- */
  function inSpan(spans, i) {
    if (!spans) return null;
    for (var k = 0; k < spans.length; k++) if (i >= spans[k].start && i < spans[k].end) return spans[k];
    return null;
  }

  function isRelMarker(W, i) {
    var L = lex();
    var w = W[i].w, p = W[i].pos;
    return h(L.REL_PRON, w) && (p === 'pron' || p === 'adv' || p === 'det' || p === 'conj');
  }

  function hasAntecedent(W, s, i) {
    for (var j = i - 1; j >= s; j--) {
      var p = W[j].pos;
      if (p === 'noun' || p === 'propn' || p === 'num') return true;
      if (p === 'verb' || p === 'aux' || p === 'modal' || p === 'prep') return false;
      if (p === 'conj' && !h(lex().COORD_CONJ, W[j].w)) return false;
    }
    return false;
  }

  function findRelEnd(W, after, i, to, nested) {
    var g1 = findFiniteGroup(W, i + 1, to, nested);
    if (!g1) return to;
    var g2 = findFiniteGroup(W, g1.end, to, nested);
    if (!g2) return to;
    var end = g2.start;
    for (var k = g1.end - 1; k < end; k++) {
      if (hasComma(after, k)) return k + 1;
    }
    return end;
  }

  function findSubEnd(W, after, i, to, nested) {
    var g1 = findFiniteGroup(W, i + 1, to, nested);
    if (!g1) return to;
    var comma = -1;
    for (var k = g1.end - 1; k < to; k++) {
      if (hasComma(after, k)) { comma = k + 1; break; }
    }
    if (comma > 0) return comma;
    var g2 = findFiniteGroup(W, g1.end, to, nested);
    if (!g2) return to;
    var end = g2.start;
    var g2Inverted = W[g2.start].pos === 'aux' || W[g2.start].pos === 'modal' || AUX_WORD[W[g2.start].w];
    for (var q = g2.start - 1; !g2Inverted && q >= g1.end; q--) {
      var p = W[q].pos;
      if (p === 'det' || p === 'adj' || p === 'noun' || p === 'propn' || p === 'num' || p === 'pron' || p === 'adv') end = q;
      else break;
    }
    return end;
  }

  /* 顶层并列分句边界 */
  function topSegments(W, after) {
    var L = lex();
    var n = W.length;
    var bounds = [0];
    var i, k;
    for (i = 1; i < n; i++) {
      if (hasSemi(after, i - 1)) { bounds.push(i); continue; }
      /* 逗号分裂的并列分句：前置段有限定动词，逗号后是「主语 + 限定动词」 */
      if (hasComma(after, i - 1) && i > 0) {
        var cp = W[i].pos, cw = W[i].w;
        var subjLike = cp === 'det' || cp === 'pron' || cp === 'noun' || cp === 'propn' || cp === 'num';
        var isMarker = h(L.REL_PRON, cw) || h(L.SUB_CONJ, cw) || h(L.WH_WORD, cw) ||
          /^(who|whom|whose|which|that|when|where|why|what|how|whether|whatever|whoever|whomever|whichever|and|or|but|nor|yet|so)$/.test(cw);
        if (subjLike && !isMarker) {
          var prevSeg = bounds[bounds.length - 1];
          var leadNF = leadingNonfinite(W, after, prevSeg, i + 1);
          if (leadNF > prevSeg) continue;   /* Having finished …, / To master …, 不是并列分句 */
          var vBefore = false;
          for (k = prevSeg; k < i; k++) if (isFiniteToken(W, k)) { vBefore = true; break; }
          var vAfter = false;
          for (var qa = 1; qa <= 6 && i + qa < n; qa++) if (isFiniteToken(W, i + qa)) { vAfter = true; break; }
          if (vBefore && vAfter) { bounds.push(i); continue; }
        }
      }
      if (!(W[i].pos === 'conj' && h(L.COORD_CONJ, W[i].w))) continue;
      var segStart = bounds[bounds.length - 1];
      var hasVerb = false;
      for (k = segStart; k < i; k++) {
        if (W[k].pos === 'verb' || W[k].pos === 'aux' || W[k].pos === 'modal') { hasVerb = true; break; }
      }
      if (!hasVerb) continue;
      var subjish = false, verbAfter = false;
      for (var q = 0; q < 6 && i + 1 + q < n; q++) {
        var t = W[i + 1 + q];
        if (q === 0 && (t.pos === 'pron' || t.pos === 'det' || t.pos === 'noun' || t.pos === 'propn' || t.pos === 'num' || t.pos === 'adv')) subjish = true;
        if (t.pos === 'verb' || t.pos === 'aux' || t.pos === 'modal') { verbAfter = true; break; }
        if (t.pos === 'prep' && q === 0) break;
      }
      if (subjish && verbAfter) bounds.push(i);
    }
    var segs = [];
    for (i = 0; i < bounds.length; i++) {
      var s = bounds[i];
      var e = i + 1 < bounds.length ? bounds[i + 1] : n;
      if (e > s) segs.push({ start: s, end: e, type: i === 0 ? 'main' : 'coord' });
    }
    return segs;
  }

  function classifySub(W, i, segStart) {
    var w = W[i].w;
    var pj0 = i - 1;
    var pw0 = pj0 >= 0 ? W[pj0].w : '';
    /* so that / such that / in order that / now that 是状语从句 */
    if (pw0 === 'so' || pw0 === 'such' || pw0 === 'now' || (pw0 === 'order' && i >= 2 && W[i - 2].w === 'in')) return '状语从句';
    if (/^(when|whenever|where|wherever|how|because|although|though|unless|while|whereas|since|until|till|before|after|as|once|lest|so|even)$/.test(w)) return '状语从句';
    if (!/^(that|whether|if|what|whatever|who|whom|whose|which|whoever|whomever|when|where|why|how)$/.test(w)) return '状语从句';
    /* 向前 4 个 token 找谓语/介词（跳过 adv/adj/conj/代词），找到 → 宾语从句 */
    for (var d = 1; d <= 4; d++) {
      var j = i - d;
      if (j < 0 || j < segStart - 1) break;
      var jp = W[j].pos;
      if (jp === 'noun' && h(lex().ABSTRACT_NOUN, W[j].w)) return '名词性从句（同位语从句）';
      if (jp === 'verb' || jp === 'aux' || jp === 'modal' || jp === 'prep') return '名词性从句';
      if (jp === 'det' || jp === 'num') break;
      if (jp === 'noun' || jp === 'propn') break;
      /* adv/adj/conj/pron 继续向前找 */
    }
    if (i === segStart && /^(that|whether|what|whatever|who|whom|whose|which|whoever|whomever)$/.test(w)) return '名词性从句';
    return '状语从句';
  }

  /* 在 [s,e) 内找嵌套从句（不含 s 处，除非是引导词） */
  function scanNested(W, after, s, e, out, depth) {
    if (depth > 5) return;
    var i = s;
    while (i < e) {
      var w = W[i].w;
      var p = W[i].pos;
      var end = -1;

      if ((p === 'pron' || p === 'det') && h(lex().REL_PRON, w) && hasAntecedent(W, s, i)) {
        end = findRelEnd(W, after, i, e, null);
        if (end > i + 1) {
          out.push({ start: i, end: end, type: 'rel', marker: i, label: '定语从句' });
          scanNested(W, after, i + 1, end, out, depth + 1);
          i = end; continue;
        }
      }
      if (p === 'adv' && WH_ADV[w] && hasAntecedent(W, s, i)) {
        end = findRelEnd(W, after, i, e, null);
        if (end > i + 1) {
          out.push({ start: i, end: end, type: 'rel', marker: i, label: '定语从句' });
          scanNested(W, after, i + 1, end, out, depth + 1);
          i = end; continue;
        }
      }
      /* 省略关系代词：名词 + 主语代词 + 有限动词 */
      if (p === 'pron' && h(lex().SUBJ_PRON, w) && i > s && (W[i - 1].pos === 'noun' || W[i - 1].pos === 'propn') &&
        W[s] && (W[s].pos === 'det' || W[s].pos === 'adj' || W[s].pos === 'num' || W[s].pos === 'noun' || W[s].pos === 'propn' || W[s].pos === 'pron')) {
        var noVerbBefore = true;
        for (var k = s; k < i; k++) if (isFiniteToken(W, k)) { noVerbBefore = false; break; }
        if (noVerbBefore && i + 1 < e && isFiniteToken(W, i + 1)) {
          end = findRelEnd(W, after, i, e, null);
          if (end > i + 1) {
            out.push({ start: i, end: end, type: 'rel', marker: -1, label: '定语从句（省略关系词）', ellipsis: true });
            scanNested(W, after, i, end, out, depth + 1);
            i = end; continue;
          }
        }
      }
      /* 从属连词 / 名词性从句引导词 */
      var subOk = false;
      if (p === 'conj' && h(lex().SUB_CONJ, w)) subOk = true;
      if ((p === 'adv' || p === 'pron' || p === 'conj' || p === 'det') &&
        /^(when|where|why|how|what|whatever|whoever|whomever|whether|if|that|who|whom|whose|which|that)$/.test(w)) subOk = true;
      if (subOk) {
        var label0 = classifySub(W, i, s);
        end = findSubEnd(W, after, i, e, null);
        /* 宾语从句（引导词前是动词）一般延伸到段末，避免把从句谓语当主句谓语 */
        if (label0.indexOf('名词性') === 0) {
          var pv = i - 1;
          if (pv >= 0 && (W[pv].pos === 'verb' || W[pv].pos === 'aux' || W[pv].pos === 'modal' || W[pv].pos === 'prep')) end = e;
          else {
            for (var pvd = 1; pvd <= 3; pvd++) {
              var pvj = i - pvd;
              if (pvj < 0 || W[pvj].pos === 'noun' || W[pvj].pos === 'det') break;
              if (W[pvj].pos === 'verb' || W[pvj].pos === 'aux' || W[pvj].pos === 'modal') { end = e; break; }
            }
          }
        }
        var hasFiniteInClause = findFiniteGroup(W, i + 1, end, null);
        if (end > i + 1 && (hasFiniteInClause || end < e)) {
          out.push({ start: i, end: end, type: 'sub', marker: i, label: label0 });
          scanNested(W, after, i + 1, end, out, depth + 1);
          i = end; continue;
        }
      }
      i++;
    }
  }

  /* 逗号之间的分词/形容词短语：The students, excited by the news, rushed */
  function findInsertedSpans(W, after, segs) {
    var out = [];
    for (var si = 0; si < segs.length; si++) {
      var segStart = segs[si].start, segEnd = segs[si].end;
      for (var i = segStart; i < segEnd - 2; i++) {
        if (!hasComma(after, i)) continue;
        var s = i + 1;
        if (s >= segEnd) continue;
        if (W[s].pos !== 'verb' && W[s].pos !== 'adj') continue;
        if (!/(?:ing|ed)$/.test(W[s].w) && !h(lex().IRREG_PP, W[s].w)) continue;
        /* 分句里已经出现限定动词 → 这是并列谓语，不是插入语 */
        var finiteBefore = false;
        for (var b = segStart; b < i; b++) if (isFiniteToken(W, b)) { finiteBefore = true; break; }
        if (finiteBefore) continue;
        var end = -1;
        for (var j = s + 1; j < segEnd - 1; j++) { if (hasComma(after, j)) { end = j + 1; break; } }
        if (end < 0) continue;
        var hasFin = false;
        for (var k2 = s; k2 < end; k2++) if (k2 > s && isFiniteToken(W, k2)) hasFin = true;
        if (hasFin) continue;
        if (out.length && s < out[out.length - 1].end) continue;
        out.push({ start: s, end: end, type: 'nonfinite', marker: -1, label: '非谓语短语（分词）', inserted: true });
      }
    }
    return out;
  }

  function collectClauses(W, after, segs) {
    var nested = [], k;
    for (k = 0; k < segs.length; k++) scanNested(W, after, segs[k].start, segs[k].end, nested, 0);
    var ins = findInsertedSpans(W, after, segs);
    for (k = 0; k < ins.length; k++) nested.push(ins[k]);
    var seen = {}, clean = [];
    for (k = 0; k < nested.length; k++) {
      var c = nested[k];
      if (c.end <= c.start) continue;
      var key = c.start + ':' + c.end;
      if (seen[key]) continue;
      seen[key] = 1;
      clean.push(c);
    }
    clean.sort(function (a, b) { return a.start - b.start || (b.end - a.end); });
    return clean;
  }

  /* ---------------- 成分标注 ---------------- */
  function setNP(W, roles, phrases, i, role) {
    var p = W[i].pos;
    if (p === 'adv') { roles[i] = 'adv'; phrases[i] = 'AdvP'; return; }
    if (p === 'conj') { roles[i] = 'conj'; phrases[i] = ''; return; }
    if (p === 'prep') { roles[i] = 'prep'; phrases[i] = 'PP'; return; }
    if (p === 'det') { roles[i] = 'det'; phrases[i] = 'NP'; return; }
    if (p === 'adj') { roles[i] = 'attr'; phrases[i] = 'NP'; return; }
    if (p === 'num') { roles[i] = 'attr'; phrases[i] = 'NP'; return; }
    roles[i] = role;
    phrases[i] = (role === 'comp' && p === 'adj') ? 'AdjP' : 'NP';
  }

  function isDegreeAdv(w) { return /^(very|quite|rather|too|so|really|extremely|fairly|pretty|almost|nearly|more|most|less|least)$/.test(w); }
  var COMPLEX_TRANS = { make: 1, makes: 1, made: 1, keep: 1, keeps: 1, kept: 1, find: 1, finds: 1, found: 1,
    consider: 1, considers: 1, considered: 1, think: 1, thinks: 1, thought: 1, call: 1, calls: 1, called: 1,
    name: 1, named: 1, elect: 1, elected: 1, leave: 1, leaves: 1, left: 1, paint: 1, painted: 1, turn: 1, turns: 1,
    get: 1, gets: 1, got: 1, drive: 1, drives: 1, drove: 1, set: 1, sets: 1 };
  var DITRANSITIVE = { give: 1, gives: 1, gave: 1, given: 1, tell: 1, tells: 1, told: 1, show: 1, shows: 1, showed: 1, shown: 1,
    offer: 1, offers: 1, offered: 1, teach: 1, teaches: 1, taught: 1, send: 1, sends: 1, sent: 1, buy: 1, buys: 1, bought: 1,
    lend: 1, lends: 1, lent: 1, promise: 1, promises: 1, promised: 1, pass: 1, passes: 1, passed: 1, bring: 1, brings: 1, brought: 1,
    hand: 1, hands: 1, handed: 1, wish: 1, wishes: 1, wished: 1, ask: 1, asks: 1, asked: 1, cost: 1, costs: 1, throw: 1, throws: 1, threw: 1, thrown: 1 };
  function isDegreeAdv2() { return true; }

  /* 解析 NP（返回结束位置；失败返回 s） */
  function parseNP(W, roles, phrases, s, e, role) {
    var i = s, got = false;
    while (i < e) {
      var p = W[i].pos, w = W[i].w;
      if (p === 'det') { roles[i] = 'det'; phrases[i] = 'NP'; i++; continue; }
      if (p === 'num') {
        var nxt = (i + 1 < e) ? W[i + 1].pos : '';
        if (nxt === 'noun' || nxt === 'propn' || nxt === 'adj' || nxt === 'num') { roles[i] = 'det'; phrases[i] = 'NP'; i++; continue; }
        roles[i] = role; phrases[i] = 'NP'; got = true; i++; break;
      }
      if (p === 'adj') { roles[i] = 'attr'; phrases[i] = 'NP'; i++; continue; }
      if (p === 'noun') {
        roles[i] = role; phrases[i] = 'NP'; got = true; i++;
        while (i < e && W[i].pos === 'noun') { roles[i] = role; phrases[i] = 'NP'; i++; }
        break;
      }
      if (p === 'propn' || p === 'pron') { roles[i] = role; phrases[i] = 'NP'; got = true; i++; break; }
      if (p === 'verb' && /ing$/.test(w)) { roles[i] = role; phrases[i] = 'GerP'; got = true; i++; continue; }
      break;
    }
    return got ? i : s;
  }

  var TIME_NOUN = { year: 1, years: 1, month: 1, months: 1, week: 1, weeks: 1, day: 1, days: 1, hour: 1, hours: 1,
    minute: 1, minutes: 1, morning: 1, afternoon: 1, evening: 1, night: 1, time: 1, times: 1, century: 1, weekend: 1 };
  var TIME_DET = { next: 1, last: 1, this: 1, every: 1, each: 1 };
  function isTimeNP(W, s, e) {
    var head = '';
    for (var i = s; i < e; i++) if (W[i].pos === 'noun') head = W[i].w;
    if (!TIME_NOUN[head]) return false;
    /* 只有 next/last/this/every/each 或数词开头才算时间状语；the day 仍是宾语 */
    if (TIME_DET[W[s].w]) return true;
    if (W[s].pos === 'num') return true;
    return false;
  }
  function markAdv(W, roles, phrases, s, e) {
    for (var i = s; i < e; i++) {
      if (W[i].pos === 'det') { roles[i] = 'det'; phrases[i] = 'AdvP'; }
      else { roles[i] = 'adv'; phrases[i] = 'AdvP'; }
    }
  }
  function parsePP(W, roles, phrases, s, e, role) {
    var i = s;
    var gotHead = false;
    roles[i] = 'prep'; phrases[i] = 'PP';
    i++;
    while (i < e) {
      var p = W[i].pos;
      if (gotHead) {
        /* 复合名词（the back of the chair）继续；其它成分不吞 */
        if (p === 'noun') { roles[i] = role; phrases[i] = 'PP'; i++; continue; }
        break;
      }
      if (p === 'det') { roles[i] = 'det'; phrases[i] = 'PP'; i++; continue; }
      if (p === 'adj' || p === 'num') { roles[i] = 'attr'; phrases[i] = 'PP'; i++; continue; }
      if (p === 'noun' || p === 'propn' || p === 'pron') { roles[i] = role; phrases[i] = 'PP'; gotHead = true; i++; continue; }
      if (p === 'adv') { roles[i] = 'adv'; phrases[i] = 'PP'; i++; continue; }
      break;
    }
    return i;
  }

  function nonfiniteEnd(W, after, s, e) {
    var i = s;
    while (i < e) {
      if (i > s && hasComma(after, i - 1)) break;
      if (i > s && W[i].pos === 'conj' && !/^(and|or)$/.test(W[i].w)) break;
      var p = W[i].pos, w = W[i].w;
      if (i > s && (p === 'verb' || p === 'aux' || p === 'modal') && !/ing$/.test(w)) {
        var prevp = i > 0 ? W[i - 1].pos : '';
        if (prevp === 'noun' || prevp === 'propn' || prevp === 'pron') { i++; continue; }
        break;
      }
      if (p === 'prep') { i = parsePP(W, {}, {}, i, e, 'obj'); continue; }
      i++;
    }
    return i;
  }

  function markNonfinite(W, roles, phrases, s, e) {
    var ph = 'PartP';
    if (W[s].pos === 'part' && W[s].w === 'to') ph = 'InfP';
    else if (/ing$/.test(W[s].w)) ph = 'GerP';
    for (var i = s; i < e && i < W.length; i++) {
      var p = W[i].pos;
      if (p === 'det') { roles[i] = 'det'; phrases[i] = ph; }
      else if (p === 'prep') { roles[i] = 'prep'; phrases[i] = 'PP'; }
      else if (p === 'conj') { roles[i] = 'conj'; phrases[i] = ph; }
      else { roles[i] = 'nonfin'; phrases[i] = ph; }
    }
  }

  function leadingNonfinite(W, after, s, e) {
    if (s >= e) return s;
    var p = W[s].pos, w = W[s].w;
    var L = lex();
    var looks = (p === 'verb' && (/(?:ing|ed)$/.test(w) || h(L.IRREG_PP, w))) ||
      (p === 'part' && w === 'to') || (p === 'adj' && /ed$/.test(w));
    if (!looks || isFiniteToken(W, s)) return s;
    for (var i = s; i < e - 1; i++) {
      if (hasComma(after, i)) return i + 1;
    }
    return s;
  }

  /* 主语后逗号间的插入语：The students, excited by the news, rushed */
  function markInserted(W, after, roles, phrases, s, e, nested) {
    if (s >= e) return false;
    var isNF = (W[s].pos === 'verb' || W[s].pos === 'adj') && (/(?:ing|ed)$/.test(W[s].w) || h(lex().IRREG_PP, W[s].w));
    for (var i = s; i < e; i++) {
      if (inSpan(nested, i)) continue;
      var p = W[i].pos;
      if (isNF) {
        if (p === 'det') { roles[i] = 'det'; phrases[i] = 'PartP'; }
        else if (p === 'prep') { roles[i] = 'prep'; phrases[i] = 'PP'; }
        else { roles[i] = 'nonfin'; phrases[i] = 'PartP'; }
      } else {
        if (p === 'det') { roles[i] = 'det'; phrases[i] = 'NP'; }
        else if (p === 'prep') { roles[i] = 'prep'; phrases[i] = 'PP'; }
        else { roles[i] = 'appos'; phrases[i] = 'NP'; }
      }
    }
    return isNF;
  }

  /* ---------------- 主干解析 ---------------- */
  /* 句首是否 it 形式主语 */
  function isExpletiveIt(W, nested, start, g, e) {
    var i;
    var hw = g && W[g.head] ? W[g.head].w : '';
    if (/^(seems?|seemed|appears?|appeared|happens?|happened|turns?|turned|looks?|looked|follows|followed)$/.test(hw)) return true;
    if (!BE_WORD[hw]) return false;
    for (i = g.end; i < e; i++) {
      if (W[i].pos === 'part' && W[i].w === 'to') return true;
      if (W[i].pos === 'conj' && (W[i].w === 'that' || W[i].w === 'whether')) return true;
    }
    if (nested) {
      for (i = 0; i < nested.length; i++) if (nested[i].start >= start && nested[i].end <= e) return true;
    }
    return false;
  }

  /* 句首引导词（that/whether/what/who…）被误当主语时跳过 */
  function skipInitialMarker(W, s, e) {
    if (s >= e) return s;
    var w = W[s].w, p = W[s].pos;
    if (p === 'conj' && w === 'that') return s + 1;
    if ((p === 'conj' || p === 'pron' || p === 'adv') && /^(whether|what|whatever|whoever|whomever)$/.test(w)) {
      /* 从句整体已被 nested 覆盖时不会走到这里 */
      return s + 1;
    }
    return s;
  }

  function parseSkeleton(W, after, seg, nested, ctx) {
    var L = lex();
    var s = seg.start, e = seg.end;
    var roles = ctx.roles, phrases = ctx.phrases;
    var res = { subj: null, pred: null, obj: [], comp: null, head: -1, verbGroup: null, seg: seg, inverted: false };
    var i, j, k, sp;

    /* 0. 并列连词本身 */
    if (W[s].pos === 'conj' && h(L.COORD_CONJ, W[s].w) && s + 1 < e) { roles[s] = 'conj'; phrases[s] = ''; s = s + 1; }

    /* 1. 跳过开头就是嵌套从句的情况（Although …, / When …, / The book, which …） */
    var guard = 0;
    while (s < e && guard++ < 8) {
      sp = inSpan(nested, s);
      if (sp && sp.start === s) { s = sp.end; continue; }
      break;
    }
    s = skipInitialMarker(W, s, e);

    /* 2. 句首非谓语短语 */
    var leadEnd = leadingNonfinite(W, after, s, e);
    if (leadEnd > s) {
      markNonfinite(W, roles, phrases, s, leadEnd);
      ctx.nonfiniteLead = { start: s, end: leadEnd };
      s = leadEnd;
      while (s < e && (sp = inSpan(nested, s)) && sp.start === s) s = sp.end;
    }
    /* 3. 前置状语 / 介词短语 */
    guard = 0;
    while (s < e && guard++ < 12) {
      sp = inSpan(nested, s);
      if (sp && sp.start === s) { s = sp.end; continue; }
      if (W[s].pos === 'adv' && W[s].w !== 'not' && !isFiniteToken(W, s)) {
        roles[s] = 'adv'; phrases[s] = 'AdvP'; s++;
        continue;
      }
      if (W[s].pos === 'prep') { s = parsePP(W, roles, phrases, s, e, 'adv'); continue; }
      if (W[s].pos === 'conj' && h(L.COORD_CONJ, W[s].w)) { roles[s] = 'conj'; s++; continue; }
      break;
    }
    if (s >= e) return res;

    /* 4. there be / it 形式主语 */
    var thereAt = (W[s].w === 'there' && W[s].pos === 'pron') ? s : -1;

    /* 5. 找第一个有限动词组 */
    var g = findFiniteGroup(W, s, e, nested);
    if (!g) return res;

    /* 6. 倒装 / 疑问：动词组前没有真正主语 */
    var hasSubjBefore = false;
    for (i = s; i < g.start; i++) {
      sp = inSpan(nested, i);
      if (sp) { i = sp.end - 1; continue; }
      var pi = W[i].pos;
      if (pi === 'det' || pi === 'noun' || pi === 'propn' || pi === 'num' || pi === 'pron') { hasSubjBefore = true; break; }
      if (pi === 'prep') { i = parsePP(W, {}, {}, i, e, 'adv') - 1; }
    }
    var hadLeadingClause = false;
    var leadSp = inSpan(nested, seg.start);
    if (leadSp && leadSp.start === seg.start) hadLeadingClause = true;
    var inverted = !hasSubjBefore && !hadLeadingClause && (W[g.start].pos === 'aux' || W[g.start].pos === 'modal' || AUX_WORD[W[g.start].w]);

    if (inverted) {
      ctx.inversion = { start: g.start, end: g.end };
      var auxEnd = g.start;
      while (auxEnd < e && (W[auxEnd].pos === 'aux' || W[auxEnd].pos === 'modal' || AUX_WORD[W[auxEnd].w] ||
        (W[auxEnd].pos === 'adv' && W[auxEnd].w === 'not'))) auxEnd++;
      for (i = g.start; i < auxEnd; i++) {
        if (W[i].pos === 'adv') { roles[i] = 'adv'; phrases[i] = 'AdvP'; }
        else { roles[i] = 'aux'; phrases[i] = 'VP'; }
      }
      res.auxes = range(g.start, auxEnd);
      var vj = -1;
      for (k = auxEnd; k < e; k++) {
        sp = inSpan(nested, k);
        if (sp) { k = sp.end - 1; continue; }
        if (W[k].pos === 'verb' || (W[k].pos === 'aux' && !AUX_WORD[W[k].w])) { vj = k; break; }
      }
      if (vj < 0) vj = auxEnd;
      if (vj > auxEnd) {
        res.subj = { start: auxEnd, end: vj };
        for (i = auxEnd; i < vj; i++) {
          if (W[i].pos === 'adv') { roles[i] = 'adv'; phrases[i] = 'AdvP'; continue; }
          if (inSpan(nested, i)) continue;
          if (W[i].pos === 'det') { roles[i] = 'det'; phrases[i] = 'NP'; }
          else if (W[i].pos === 'adj') { roles[i] = 'attr'; phrases[i] = 'NP'; }
          else { roles[i] = 'subj'; phrases[i] = 'NP'; }
        }
      }
      if (!res.subj) { ctx.imperative = true; res.imperative = true; }
      var g2 = verbGroupAt(W, vj, e) || { start: vj, end: vj + 1, head: vj, auxes: [] };
      markVerbGroup(W, roles, phrases, g2);
      res.pred = { start: g2.head, end: g2.head + 1 };
      res.head = g2.head; res.verbGroup = g2;
      predicateRest(W, after, roles, phrases, g2.end, e, g2.head, nested, res);
      return res;
    }

    /* 7. existential there */
    if (thereAt >= 0) {
      roles[thereAt] = ''; phrases[thereAt] = '';
      ctx.there = thereAt;
      markVerbGroup(W, roles, phrases, g);
      res.pred = { start: g.head, end: g.head + 1 };
      res.head = g.head; res.verbGroup = g; res.existential = true;
      var eobj = parseNP(W, roles, phrases, g.end, e, 'subj');
      if (eobj > g.end) {
        res.subj = { start: g.end, end: eobj };
        for (i = g.end; i < eobj; i++) setNP(W, roles, phrases, i, 'subj');
        predicateRest(W, after, roles, phrases, eobj, e, g.head, nested, res);
      }
      return res;
    }

    /* 8. 正常语序：主语 = s .. g.start（去掉嵌套从句与插入语） */
    var subjStart = s;
    var subjEnd = g.start;
    var cut = -1;
    for (i = subjStart; i < subjEnd; i++) {
      sp = inSpan(nested, i);
      if (sp) { if (sp.start < subjEnd && sp.start >= subjStart) subjEnd = sp.start; break; }
      if (hasComma(after, i) && i + 1 < subjEnd) { cut = i + 1; break; }
    }
    var subjEndFinal = subjEnd;
    var insertedIsNonfinite = false;
    if (cut > 0 && cut < subjEndFinal) {
      subjEndFinal = cut;
      var cutSpan = inSpan(nested, cut);
      if (cutSpan && cutSpan.start === cut) {
        /* The book, which ……, has been …：逗号后是定语从句，剩余部分按状语处理 */
        for (var ci = cut; ci < subjEnd; ci++) {
          if (inSpan(nested, ci)) { ci = inSpan(nested, ci).end - 1; continue; }
          if (W[ci].pos === 'adv') { roles[ci] = 'adv'; phrases[ci] = 'AdvP'; }
          else if (W[ci].pos === 'prep') { roles[ci] = 'prep'; phrases[ci] = 'PP'; }
        }
      } else {
        insertedIsNonfinite = markInserted(W, after, roles, phrases, cut, subjEnd, nested);
        if (insertedIsNonfinite) ctx.inserted = { start: cut, end: subjEnd };
        else ctx.appos = { start: cut, end: subjEnd - 1 };
      }
    }
    res.subj = (subjEndFinal > subjStart) ? { start: subjStart, end: subjEndFinal } : null;
    for (i = subjStart; i < subjEndFinal; i++) {
      if (inSpan(nested, i)) continue;
      setNP(W, roles, phrases, i, 'subj');
    }
    /* it 形式主语：本身不作成分 */
    if (W[subjStart] && W[subjStart].w === 'it' && res.subj && isExpletiveIt(W, nested, subjStart, g, e)) {
      roles[subjStart] = ''; phrases[subjStart] = '';
      ctx.it = subjStart;
    }
    if (!res.subj) { ctx.imperative = true; res.imperative = true; }

    /* 9. 谓语组 */
    markVerbGroup(W, roles, phrases, g);
    res.pred = { start: g.head, end: g.head + 1 };
    res.head = g.head; res.verbGroup = g;

    /* 10. 谓语后成分 */
    predicateRest(W, after, roles, phrases, g.end, e, g.head, nested, res);
    return res;
  }

  function markVerbGroup(W, roles, phrases, g) {
    for (var i = g.start; i < g.end; i++) {
      if (W[i].pos === 'adv') { roles[i] = 'adv'; phrases[i] = 'AdvP'; }
      else if (i === g.head) { roles[i] = 'pred'; phrases[i] = 'VP'; }
      else { roles[i] = 'aux'; phrases[i] = 'VP'; }
    }
  }

  function range(a, b) { var o = []; for (var i = a; i < b; i++) o.push(i); return o; }

  /* 谓语后：宾语 / 表语 / 状语 / 非谓语 */
  function predicateRest(W, after, roles, phrases, start, e, head, nested, res) {
    var L = lex();
    var i = start;
    var headW = head >= 0 ? W[head].w : '';
    var lastDegAdv = -1;
    var linking = BE_WORD[headW] || /^(become|becomes|became|seem|seems|seemed|appear|appears|appeared|remain|remains|remained|stay|stays|stayed|feel|feels|felt|look|looks|looked|sound|sounds|sounded|taste|tastes|tasted|smell|smells|smelled|prove|proves|proved|keep|keeps|kept)$/.test(headW);
    var guard = 0;

    while (i < e && guard++ < 60) {
      var sp = inSpan(nested, i);
      if (sp) { i = sp.end; continue; }
      var p = W[i].pos, w = W[i].w;

      if (p === 'adv') { roles[i] = 'adv'; phrases[i] = 'AdvP'; if (isDegreeAdv(w)) lastDegAdv = i; i++; continue; }
      if (p === 'conj') {
        roles[i] = 'conj'; phrases[i] = ''; res.inNonfin = false;
        i++; continue;
      }
      /* 并列谓语：主语共享的第二个及以后的动词（copied / and promised / Put…pick…begin） */
      if (!res.inNonfin && res.head >= 0 && (p === 'verb' || p === 'aux' || p === 'modal') && isFiniteToken(W, i)) {
        var gExtra = verbGroupAt(W, i, e) || { start: i, end: i + 1, head: i };
        markVerbGroup(W, roles, phrases, gExtra);
        if (!res.extraPreds) res.extraPreds = [];
        res.extraPreds.push(gExtra.head);
        res.expectObj = true;
        res.inNonfin = false;
        i = gExtra.end;
        continue;
      }
      if (p === 'part' && w === 'to') {
        var nfEnd = nonfiniteEnd(W, after, i, e);
        res.inNonfin = true;
        markNonfinite(W, roles, phrases, i, nfEnd);
        if (!res.infinitive) res.infinitive = { start: i, end: nfEnd };
        i = nfEnd; continue;
      }
      if ((p === 'verb' && !isFiniteToken(W, i)) || (p === 'verb' && W[i].pos === 'verb' && prevIsTo(W, i))) {
        var nfEnd2 = nonfiniteEnd(W, after, i, e);
        res.inNonfin = true;
        markNonfinite(W, roles, phrases, i, nfEnd2);
        i = nfEnd2; continue;
      }
      if (p === 'prep' || p === 'conj') res.inNonfin = false;
      if (p === 'prep') {
        var ppEnd = parsePP(W, roles, phrases, i, e, 'adv');
        i = ppEnd; continue;
      }
      /* 表语：系动词后 / 宾语后的形容词 */
      if (p === 'adj') {
        if (linking && res.comp) { roles[i] = 'attr'; phrases[i] = 'AdjP'; i++; continue; }
        var npTry = parseNP(W, roles, phrases, i, e, 'obj');
        if (npTry > i + 1) {
          if (res.obj.length || res.comp || isTimeNP(W, i, npTry)) {
            markAdv(W, roles, phrases, i, npTry);
          } else {
            res.obj = [{ start: i, end: npTry }];
            markHeadRole(W, roles, i, npTry, 'obj');
          }
          i = npTry; continue;
        }
        if (linking || res.obj.length) {
          var cStart = (lastDegAdv === i - 1) ? lastDegAdv : i;
          res.comp = { start: cStart, end: i + 1 };
          roles[i] = 'comp'; phrases[i] = 'AdjP';
          if (cStart < i) { roles[cStart] = 'comp'; phrases[cStart] = 'AdjP'; }
          i++;
          /* quite/very 已由 adv 分支处理 */
          continue;
        }
        roles[i] = 'attr'; phrases[i] = 'AdjP'; i++; continue;
      }
      if (p === 'det' || p === 'num' || p === 'noun' || p === 'propn' || p === 'pron') {
        var npEnd = parseNP(W, roles, phrases, i, e, 'obj');
        if (npEnd <= i) { i++; continue; }
        var headV = res.head >= 0 ? W[res.head].w : '';
        var afterThan = i > 0 && W[i - 1].pos === 'conj' && /^(than|as)$/.test(W[i - 1].w);
        if (afterThan) {
          for (var kt = i; kt < npEnd; kt++) {
            if (W[kt].pos === 'det') { roles[kt] = 'det'; phrases[kt] = 'AdvP'; }
            else { roles[kt] = 'adv'; phrases[kt] = 'AdvP'; }
          }
          i = npEnd; continue;
        }
        if (isTimeNP(W, i, npEnd) && (res.obj.length || res.comp || !res.obj.length)) {
          markAdv(W, roles, phrases, i, npEnd);
          i = npEnd; continue;
        }
        if (linking && !res.comp) {
          var compEnd = npEnd;
          if (compEnd < e && W[compEnd].pos === 'prep' && W[compEnd].w === 'of') {
            compEnd = parsePP(W, roles, phrases, compEnd, e, 'comp');
          }
          res.comp = { start: i, end: compEnd };
          for (var kc = i; kc < npEnd; kc++) if (!inSpan(nested, kc)) setNP(W, roles, phrases, kc, 'comp');
          i = compEnd; continue;
        }
        if (res.comp) {
          /* 表语之后的名词短语是状语（five years ago / last month） */
          for (var ka = i; ka < npEnd; ka++) {
            if (inSpan(nested, ka)) continue;
            if (W[ka].pos === 'det' || W[ka].pos === 'num') { roles[ka] = 'det'; phrases[ka] = 'AdvP'; }
            else { roles[ka] = 'adv'; phrases[ka] = 'AdvP'; }
          }
          i = npEnd; continue;
        }
        if (res.inNonfin) {
          for (var kn = i; kn < npEnd; kn++) { if (inSpan(nested, kn)) continue; roles[kn] = (W[kn].pos === 'det') ? 'det' : 'nonfin'; phrases[kn] = 'InfP'; }
          i = npEnd; continue;
        }
        if (res.expectObj) {
          res.expectObj = false;
          res.obj.push({ start: i, end: npEnd });
          markHeadRole(W, roles, i, npEnd, 'obj');
          i = npEnd; continue;
        }
        if (!res.obj || !res.obj.length) {
          res.obj = [{ start: i, end: npEnd }];
          markHeadRole(W, roles, i, npEnd, 'obj');
        } else if (res.obj.length === 1 && !res.comp && DITRANSITIVE[headV]) {
          res.obj.push({ start: i, end: npEnd });
          markHeadRole(W, roles, i, npEnd, 'obj');
        } else {
          for (var k3 = i; k3 < npEnd; k3++) {
            if (inSpan(nested, k3)) continue;
            if (W[k3].pos === 'det') { roles[k3] = 'det'; phrases[k3] = 'AdvP'; }
            else { roles[k3] = 'adv'; phrases[k3] = 'AdvP'; }
          }
        }
        i = npEnd; continue;
      }
      i++;
    }

    /* 系动词 + NP → 表语 */
    if (linking && res.obj.length && !res.comp) {
      var first = res.obj[0];
      res.comp = first;
      res.obj = [];
      for (var q = first.start; q < first.end; q++) if (!inSpan(nested, q)) setNP(W, roles, phrases, q, 'comp');
    } else if (linking && !res.obj.length && !res.comp && !res.existential) {
      /* 表语 PP 必须是谓语后的第一个成分（The book is on the table） */
      var r0 = start;
      while (r0 < e && inSpan(nested, r0)) r0 = inSpan(nested, r0).end;
      if (r0 < e && W[r0].pos === 'prep') res.comp = { start: r0, end: parsePP(W, roles, phrases, r0, e, 'comp') };
    }
    /* 宾语补足语：make everyone happy（只认复合及物动词） */
    if (res.obj.length && !res.comp && COMPLEX_TRANS[headW]) {
      for (var m = res.obj[0].end; m < e; m++) {
        if (W[m].pos === 'adj') {
          res.comp = { start: m, end: m + 1 };
          roles[m] = 'comp'; phrases[m] = 'AdjP';
          break;
        }
        if (W[m].pos !== 'adv' && !inSpan(nested, m)) break;
      }
    }
    /* 剩余未标注 */
    for (var z = start; z < e; z++) {
      if (roles[z] || inSpan(nested, z)) continue;
      if (W[z].pos === 'noun' || W[z].pos === 'propn') { roles[z] = 'attr'; phrases[z] = 'NP'; }
      else if (W[z].pos === 'adj') { roles[z] = 'attr'; phrases[z] = 'AdjP'; }
      else if (W[z].pos === 'verb') { roles[z] = 'nonfin'; phrases[z] = 'PartP'; }
    }
    return i;
  }

  /* 只把中心词（名词/代词）角色改成 obj，限定词/形容词保持内部标注 */
  function markHeadRole(W, roles, s, e, role) {
    for (var k = s; k < e; k++) {
      if (inSpan(roles.__nested, k)) continue;
      if (W[k].pos === 'noun' || W[k].pos === 'propn' || W[k].pos === 'pron') roles[k] = role;
      else if (W[k].pos === 'num' && !roles[k]) roles[k] = role;
    }
  }
  function prevIsTo(W, i) {
    var j = i - 1;
    while (j >= 0 && W[j].pos === 'adv') j--;
    return j >= 0 && W[j].pos === 'part' && W[j].w === 'to';
  }

  /* ---------------- 嵌套从句自身成分 ---------------- */
  function parseClauseBody(W, after, c, nested, ctx) {
    var roles = ctx.roles, phrases = ctx.phrases;
    var res = { subj: null, head: -1, obj: [], comp: null, isNoun: false };
    var s = c.start, e = c.end;
    if (e <= s) return res;
    var marker = c.marker >= 0 ? c.marker : s;
    var bodyStart = c.marker >= 0 ? c.marker + 1 : s;
    if (c.type === 'nonfinite') { markNonfinite(W, roles, phrases, s, e); ctx.inserted = { start: s, end: e }; return res; }
    /* 排除自身，否则会把整段从句当成嵌套跳过 */
    var nested2 = [];
    for (var ni = 0; ni < nested.length; ni++) if (nested[ni] !== c) nested2.push(nested[ni]);

    if (c.type === 'rel') {
      if (c.marker >= 0) { roles[marker] = 'rel'; phrases[marker] = 'Clause'; }
      var g = findFiniteGroup(W, bodyStart, e, nested2);
      if (!g) return res;
      var isSubjMarker = c.marker >= 0 && g.start === bodyStart;
      if (isSubjMarker) {
        roles[marker] = 'rel'; phrases[marker] = 'NP';
        res.subj = { start: marker, end: marker + 1 };
      } else {
        res.subj = { start: bodyStart, end: g.start };
        for (var i = bodyStart; i < g.start; i++) setNP(W, roles, phrases, i, 'subj');
      }
      markVerbGroup(W, roles, phrases, g);
      res.head = g.head;
      predicateRest(W, after, roles, phrases, g.end, e, g.head, nested2, res);
      return res;
    }

    if (c.marker >= 0) { roles[c.marker] = 'mark'; phrases[c.marker] = 'Clause'; }
    var body = { start: bodyStart, end: e, type: 'sub' };
    var r2 = parseSkeleton(W, after, body, nested2, ctx);
    res.subj = r2.subj; res.head = r2.head; res.obj = r2.obj; res.comp = r2.comp;
    res.isNoun = !!(c.label && c.label.indexOf('名词性') === 0);
    return res;
  }

  /* ---------------- 语法点 notes ---------------- */
  function buildNote(kind, title, detail, s, e, W) {
    var start = (s >= 0 && W[s]) ? W[s].s : 0;
    var end = (e > s && W[e - 1]) ? W[e - 1].e : start;
    return { kind: kind, title: title, detail: detail, start: start, end: end };
  }
  function note(notes, kind, title, detail, s, e, W) {
    notes.push(buildNote(kind, title, detail, s, e, W));
  }

  function notePass(W, after, clauses, segs, ctx, notes) {
    var L = lex();
    var n = W.length, i;
    var seenPassive = false, seenPerfect = false, seenProg = false, modalCount = 0;

    for (i = 0; i < n; i++) {
      var w = W[i].w, p = W[i].pos;
      if (p === 'modal' || h(L.CONTRACT_MODAL, w)) {
        if (modalCount < 2) note(notes, 'modal', '情态动词', '"' + W[i].t + '" 是情态动词，后接动词原形，表示能力/可能/必须等。', i, i + 1, W);
        modalCount++;
        continue;
      }
      if (h(L.BE, w) && (p === 'aux' || p === 'verb')) {
        var j = i + 1;
        while (j < n && W[j].pos === 'adv' && (W[j].w === 'not' || W[j].w === 'never')) j++;
        if (j < n && (W[j].pos === 'verb' || W[j].pos === 'adj')) {
          var vw = W[j].w;
          if (/ing$/.test(vw) && !seenProg) {
            seenProg = true;
            note(notes, 'progressive', '进行时', '"' + W[i].t + ' ' + W[j].t + '" 构成进行时：正在发生或持续的动作。', i, j + 1, W);
          } else if ((/ed$/.test(vw) || h(L.IRREG_PP, vw)) && !seenPassive) {
            seenPassive = true;
            var byi = -1;
            for (var q = j + 1; q < n && q < j + 7; q++) { if (W[q].pos === 'prep' && W[q].w === 'by') { byi = q; break; } }
            var end = byi >= 0 ? parsePP(W, {}, {}, byi, n, 'adv') : j + 1;
            note(notes, 'passive', '被动语态', 'be + 过去分词：主语是动作的承受者' + (byi >= 0 ? '，by 引出动作的发出者。' : '。'), i, end, W);
          }
        }
      }
      if (h(L.HAVE, w) && (p === 'aux' || p === 'verb') && !seenPerfect) {
        var k = i + 1;
        while (k < n && W[k].pos === 'adv' && W[k].w === 'never') k++;
        if (k < n && W[k].w === 'been') k++;
        while (k < n && W[k].pos === 'adv') k++;
        if (k < n && (W[k].pos === 'verb' || W[k].pos === 'adj') && (/ed$/.test(W[k].w) || h(L.IRREG_PP, W[k].w))) {
          seenPerfect = true;
          note(notes, 'perfect', '完成时', '"have/has/had + 过去分词" 表示已经完成或持续到现在的动作。', i, k + 1, W);
        }
      }
    }

    /* 不定式 */
    var infCount = 0;
    for (i = 0; i < n; i++) {
      if (W[i].pos === 'part' && W[i].w === 'to' && i + 1 < n && W[i + 1].pos === 'verb') {
        if (infCount < 2) note(notes, 'nonfinite-infinitive', '不定式', '"to ' + W[i + 1].t + '" 是不定式，可作主语、宾语或目的状语。', i, i + 2, W);
        infCount++;
      }
    }
    /* 分词 / 动名词（取一处代表） */
    for (i = 0; i < n; i++) {
      if (W[i].pos !== 'verb') continue;
      var vw2 = W[i].w;
      if (!/ing$/.test(vw2) && !/ed$/.test(vw2) && !h(L.IRREG_PP, vw2)) continue;
      if (isFiniteToken(W, i)) continue;
      var isGer = /ing$/.test(vw2) && (i === 0 || (W[i - 1] && (W[i - 1].pos === 'prep' || W[i - 1].pos === 'noun')));
      note(notes, isGer ? 'nonfinite-gerund' : 'nonfinite-participle',
        isGer ? '动名词' : '分词结构',
        isGer ? '"' + W[i].t + '" 是动名词，整体起名词作用。' : '"' + W[i].t + '" 引导分词短语，作状语或定语。', i, Math.min(n, i + 3), W);
      break;
    }

    /* 从句 notes */
    for (i = 0; i < clauses.length; i++) {
      var c = clauses[i];
      if (c.type === 'rel') {
        note(notes, 'relative', '定语从句',
          c.ellipsis ? '省略了关系代词，修饰前面的名词。' : '"' + W[c.marker].t + '" 引导定语从句，修饰前面的名词。', c.start, c.end, W);
      } else if (c.type === 'sub') {
        if (c.label === '名词性从句') note(notes, 'noun-clause', '名词性从句', '"' + W[c.marker].t + '" 引导名词性从句，整体作主语/宾语/表语。', c.start, c.end, W);
        else if (c.label.indexOf('同位语') >= 0) note(notes, 'appositive', '同位语从句', '"' + W[c.marker].t + '" 引导同位语从句，解释前面抽象名词的内容。', c.start, c.end, W);
        else note(notes, 'adverb-clause', '状语从句', '"' + W[c.marker].t + '" 引导状语从句，说明时间/原因/条件/让步等。', c.start, c.end, W);
      }
    }

    if (ctx.there !== undefined) note(notes, 'existential-there', 'There be 句型', 'there 是引导词，真正的主语在 be 后面（a cat 才是主语）。', ctx.there, Math.min(n, ctx.there + 3), W);
    if (ctx.it !== undefined) note(notes, 'expletive-it', '形式主语 it', 'it 只是形式主语，真正的主语是后面的不定式或从句。', ctx.it, Math.min(n, ctx.it + 3), W);

    /* 并列 */
    var coordIdx = [];
    for (i = 0; i < n; i++) if (W[i].pos === 'conj' && h(L.COORD_CONJ, W[i].w)) coordIdx.push(i);
    if (coordIdx.length) {
      var hasCoordClause = false;
      for (i = 0; i < segs.length; i++) if (segs[i].type === 'coord') hasCoordClause = true;
      note(notes, 'coordinated', hasCoordClause ? '并列句' : '并列结构',
        '由 ' + coordIdx.map(function (x) { return '"' + W[x].t + '"'; }).join('、') + ' 连接' + (hasCoordClause ? '的并列分句。' : '的并列成分。'),
        coordIdx[0], coordIdx[coordIdx.length - 1] + 1, W);
    }
    if (ctx.inversion) note(notes, 'inversion', '倒装语序', '助动词/情态动词提到主语前面（疑问句或强调倒装）。', ctx.inversion.start, ctx.inversion.end, W);
    if (ctx.appos) note(notes, 'appositive', '同位语', '逗号之间的成分是对前面名词的补充说明。', ctx.appos.start, ctx.appos.end, W);
    if (ctx.inserted) note(notes, 'nonfinite-participle', '插入的分词短语', '逗号之间的分词短语作补充说明。', ctx.inserted.start, ctx.inserted.end, W);

    /* 比较结构 */
    for (i = 0; i < n; i++) {
      if (W[i].w === 'than') {
        var prevp = i > 0 ? W[i - 1].pos : '';
        var prevw = i > 0 ? W[i - 1].w : '';
        if (prevp === 'adj' || prevp === 'adv' || /^(more|less|fewer|better|worse)$/.test(prevw)) {
          note(notes, 'comparative', '比较结构', '比较级 + than 构成比较。', Math.max(0, i - 2), Math.min(n, i + 3), W);
          break;
        }
      }
      if (W[i].w === 'as' && i > 1 && W[i - 1].pos === 'adj' && W[i - 2].pos === 'adv') {
        note(notes, 'comparative', '同级比较', 'as + 形容词/副词 + as 构成同级比较。', Math.max(0, i - 2), Math.min(n, i + 3), W);
        break;
      }
    }
    for (i = 0; i < clauses.length; i++) if (clauses[i].ellipsis) {
      note(notes, 'ellipsis', '省略关系词', '定语从句省略了关系代词（如 the book [that] I bought）。', clauses[i].start, clauses[i].end, W);
      break;
    }
  }

  /* ---------------- summary / confidence ---------------- */
  function roleChain(res) {
    var parts = [];
    if (res.subj) parts.push('主语');
    else if (res.imperative) parts.push('祈使句');
    if (res.head >= 0) {
      var np = 1 + (res.extraPreds ? res.extraPreds.length : 0);
      parts.push(np > 1 ? '谓语（并列 ' + np + ' 个）' : '谓语');
    }
    var nObj = res.obj ? res.obj.length : 0;
    if (nObj === 2 && !res.extraPreds) parts.push('双宾语');
    else if (nObj > 0) parts.push('宾语');
    if (res.comp) parts.push('表语');
    return parts;
  }

  function buildSummary(segResults, clauses, reliable, subjectClause) {
    if (!reliable) return '未能可靠识别主干（自动推断结果仅供参考）';
    var parts = [];
    for (var i = 0; i < segResults.length; i++) {
      var chain = roleChain(segResults[i]);
      if (i === 0 && subjectClause && chain.length) chain.unshift('主语从句');
      if (chain.length) parts.push(chain.join(' + '));
    }
    if (!parts.length) return '';
    var s = parts.join('；');
    var labels = {};
    for (i = 0; i < clauses.length; i++) {
      if (clauses[i].type === 'main') continue;
      var key = clauses[i].label || '';
      if (key) labels[key] = (labels[key] || 0) + 1;
    }
    var keys = Object.keys(labels);
    if (keys.length) s += '。含' + keys.map(function (k) { return labels[k] + '个' + k; }).join('，');
    return s;
  }

  function computeConfidence(W, segResults, clauses, notes, reliable, extra) {
    if (!W.length) return 0.05;
    var c = 0.5;
    if (reliable) c += 0.2;
    var mains = [];
    for (var i = 0; i < segResults.length; i++) if (segResults[i].head >= 0) mains.push(segResults[i]);
    var subjAll = true, predAll = mains.length > 0;
    for (var m = 0; m < mains.length; m++) if (!mains[m].subj && !mains[m].imperative) subjAll = false;
    if (subjAll && mains.length) c += 0.1;
    if (predAll) c += 0.1;
    c -= Math.min(0.2, clauses.length * 0.03);
    if (W.length > 32) c -= 0.06;
    if (extra.unknownRatio > 0.35) c -= 0.1;
    if (extra.multiFinite) c -= 0.08;
    if (!predAll) c = Math.min(c, 0.45);
    c = Math.max(0.05, Math.min(0.95, c));
    return Math.round(c * 100) / 100;
  }

  function spanText(W, s, e) {
    if (e <= s) return '';
    var buf = '';
    for (var i = s; i < e; i++) buf += (i > s ? ' ' : '') + W[i].t;
    return buf;
  }
  function trimSpan(nested, s, e) {
    var guard = 0;
    while (s < e && guard++ < 50) {
      var sp = inSpan(nested, s);
      if (sp && sp.start === s) s = sp.end;
      else break;
    }
    guard = 0;
    while (e > s && guard++ < 50) {
      var sp2 = inSpan(nested, e - 1);
      if (sp2 && sp2.end === e) e = sp2.start;
      else break;
    }
    return [s, e];
  }

  /* ---------------- 主入口 ---------------- */
  function analyzeText(text) {
    var src = text == null ? '' : String(text);
    var built = buildWords(src);
    var W = built.W, after = built.after;
    var out = {
      text: src,
      tokens: [],
      clauses: [],
      summary: '',
      structure: [],
      notes: [],
      confidence: 0.05
    };
    if (!W.length) return out;
    if (!DR.pos || !DR.pos.ready()) throw new Error('not-ready');

    var pos = DR.pos.tag(W);
    var i;
    for (i = 0; i < W.length; i++) {
      W[i].pos = POS_SET[pos[i]] ? pos[i] : 'noun';
      W[i].role = '';
      W[i].phrase = '';
      W[i].clause = 0;
    }

    var segs = topSegments(W, after);
    var nested = collectClauses(W, after, segs);
    /* 首段被一个完整从属/名词性从句覆盖（When …, / That …）→ 它不是主句 */
    for (i = 0; i < segs.length; i++) {
      var cs = inSpan(nested, segs[i].start);
      if (cs && cs.start === segs[i].start && cs.end >= segs[i].end) {
        if (segs[i].type === 'main') { segs[i].type = cs.type === 'rel' ? 'rel' : 'sub'; segs[i].segLabel = cs.label; }
      }
      if (i > 0 && segs[i].type === 'coord') {
        var pcs = inSpan(nested, segs[i].start - 1);
        if (pcs && pcs.end === segs[i].start) segs[i].type = 'main';
      }
    }

    var ctx = { roles: [], phrases: [], notes: [], appos: null, inserted: null, inversion: null, there: undefined, it: undefined, imperative: false };
    for (i = 0; i < W.length; i++) { ctx.roles[i] = ''; ctx.phrases[i] = ''; }

    var segResults = [];
    for (i = 0; i < segs.length; i++) segResults.push(parseSkeleton(W, after, segs[i], nested, ctx));
    var nestedBodies = [];
    for (i = 0; i < nested.length; i++) nestedBodies.push(parseClauseBody(W, after, nested[i], nested, ctx));

    lastTrace = { segs: segs, nested: nested, segResults: segResults };
    /* 主句可靠性：必须有谓语；非祈使句必须有主语 */
    var subjectClause = null;
    for (i = 0; i < nested.length; i++) {
      if (nested[i].start === 0 && nested[i].type === 'sub' && nested[i].label && nested[i].label.indexOf('名词性') === 0 && segs.length) { subjectClause = nested[i]; break; }
    }
    var reliable = false;
    var mainIdx = 0;
    for (i = 0; i < segResults.length; i++) { if (segResults[i].head >= 0) { mainIdx = i; break; } }
    if (segResults.length) {
      var first = segResults[mainIdx];
      var headIsVerb = first.head >= 0 && (W[first.head].pos === 'verb' || W[first.head].pos === 'aux' || W[first.head].pos === 'modal');
      reliable = headIsVerb && (!!first.subj || !!subjectClause || ctx.imperative);
      if (reliable && first.verbGroup) {
        for (var tv = first.verbGroup.end; tv < segs[mainIdx].end; tv++) {
          if (inSpan(nested, tv)) { tv = inSpan(nested, tv).end - 1; continue; }
          var commaSince = false;
          for (var cq = first.verbGroup.end - 1; cq < tv; cq++) if (hasComma(after, cq)) commaSince = true;
          if (tv > 0 && W[tv - 1].pos === 'conj') commaSince = true;
          if (!commaSince && W[tv].pos === 'verb' && (/(?:ed|ing)$/.test(W[tv].w) || h(lex().IRREG_PAST, W[tv].w)) && tv > 0 &&
            (W[tv - 1].pos === 'noun' || W[tv - 1].pos === 'propn') && !/^(was|were|been|being|is|are|am|has|had|have)$/.test(W[tv - 1].w)) {
            reliable = false; break;
          }
        }
      }
      /* 主句里出现多个未被切分的有限动词 → 不可靠 */
      var finiteCount = 0;
      for (i = segs[mainIdx].start; i < segs[mainIdx].end; i++) {
        if (inSpan(nested, i)) continue;
        if (isFiniteToken(W, i)) finiteCount++;
      }
      if (finiteCount > 1 && first.head >= 0) {
        var extraVerbs = 0;
        for (i = first.verbGroup ? first.verbGroup.end : first.head + 1; i < segs[mainIdx].end; i++) {
          if (inSpan(nested, i)) { i = inSpan(nested, i).end - 1; continue; }
          if (isFiniteToken(W, i) && !(i > 0 && (hasComma(after, i - 1) || W[i - 1].pos === 'conj')) &&
            !(W[i].pos === 'verb' && !/(?:ed|s)$/.test(W[i].w) && i > 0 &&
              (W[i - 1].pos === 'noun' || W[i - 1].pos === 'propn' || W[i - 1].pos === 'verb' || W[i - 1].pos === 'aux' || W[i - 1].pos === 'modal'))) extraVerbs++;
        }
        if (extraVerbs > 0) reliable = false;
      }
    }
    if (!reliable) {
      /* 宁可少标：清空主干角色，只保留从句/功能词标注 */
      for (i = 0; i < W.length; i++) {
        var r = ctx.roles[i];
        if (r === 'subj' || r === 'pred' || r === 'obj' || r === 'comp' || r === 'aux') {
          ctx.roles[i] = (W[i].pos === 'aux' || W[i].pos === 'modal') ? 'aux' : '';
          if (W[i].pos === 'aux' || W[i].pos === 'modal') ctx.phrases[i] = 'VP';
        }
      }
      for (i = 0; i < segResults.length; i++) { segResults[i].subj = null; segResults[i].obj = []; segResults[i].comp = null; }
    }

    /* 词性/角色写回 */
    for (i = 0; i < W.length; i++) {
      W[i].role = ROLE_SET[ctx.roles[i]] ? ctx.roles[i] : '';
      W[i].phrase = ctx.phrases[i] || '';
    }
    /* 分句标记角色覆盖 + token → clause 归属 */
    for (i = 0; i < nested.length; i++) {
      var nc = nested[i];
      if (nc.marker >= 0) {
        W[nc.marker].role = nc.type === 'rel' ? 'rel' : 'mark';
        W[nc.marker].phrase = 'Clause';
      }
      for (var q = nc.start; q < nc.end; q++) W[q].clause = -1;
    }
    /* 顶层分句索引 */
    var clauses = [];
    for (i = 0; i < segs.length; i++) {
      var ci = clauses.length;
      clauses.push({
        i: ci,
        start: W[segs[i].start].s,
        end: W[segs[i].end - 1].e,
        type: segs[i].type,
        label: segs[i].segLabel || (segs[i].type === 'coord' ? '并列句' : segs[i].type === 'sub' ? '状语从句' : segs[i].type === 'rel' ? '定语从句' : '主句')
      });
      for (var t = segs[i].start; t < segs[i].end; t++) if (W[t].clause === 0) W[t].clause = ci;
    }
    for (i = 0; i < nested.length; i++) {
      var nc2 = nested[i];
      var nStart = W[nc2.start].s, nEnd = W[nc2.end - 1].e;
      var dup = false;
      for (var cq2 = 0; cq2 < clauses.length; cq2++) if (clauses[cq2].start === nStart && clauses[cq2].end === nEnd) { dup = true; break; }
      if (dup) { for (var q2d = nc2.start; q2d < nc2.end; q2d++) W[q2d].clause = i + 1; continue; }
      var ci2 = clauses.length;
      clauses.push({
        i: ci2,
        start: W[nc2.start].s,
        end: W[nc2.end - 1].e,
        type: nc2.type === 'sub' ? 'sub' : nc2.type,
        label: nc2.label || CLAUSE_TYPE_LABEL(nc2.type)
      });
      for (var q2 = nc2.start; q2 < nc2.end; q2++) W[q2].clause = ci2;
    }
    /* 非谓语短语作为 nonfinite 分句 */
    addNonfiniteClauses(W, clauses);

    /* notes */
    notePass(W, after, nested, segs, ctx, ctx.notes);

    /* structure：只放可靠的主干成分 */
    var structure = [];
    if (reliable) {
      for (i = 0; i < segResults.length; i++) {
        var rr = segResults[i];
        if (rr.subj) {
          var sp1 = trimSpan(nested, rr.subj.start, rr.subj.end);
          while (sp1[0] < sp1[1] && (W[sp1[0]].role === 'adv' || W[sp1[0]].role === 'conj' || W[sp1[0]].role === 'prep' || W[sp1[0]].role === 'part')) sp1[0]++;
          while (sp1[1] > sp1[0] && (W[sp1[1] - 1].role === 'adv' || W[sp1[1] - 1].role === 'conj')) sp1[1]--;
          if (sp1[1] > sp1[0]) structure.push({ role: 'subj', start: W[sp1[0]].s, end: W[sp1[1] - 1].e, text: spanText(W, sp1[0], sp1[1]) });
        }
        if (rr.head >= 0) structure.push({ role: 'pred', start: W[rr.head].s, end: W[rr.head].e, text: W[rr.head].t });
        if (rr.extraPreds) {
          for (var ep = 0; ep < rr.extraPreds.length; ep++) {
            var epi = rr.extraPreds[ep];
            if (epi >= 0) structure.push({ role: 'pred', start: W[epi].s, end: W[epi].e, text: W[epi].t });
          }
        }
        for (var oi = 0; oi < rr.obj.length; oi++) {
          var sp2 = trimSpan(nested, rr.obj[oi].start, rr.obj[oi].end);
          if (sp2[1] > sp2[0]) structure.push({ role: 'obj', start: W[sp2[0]].s, end: W[sp2[1] - 1].e, text: spanText(W, sp2[0], sp2[1]) });
        }
        if (rr.comp) {
          var sp3 = trimSpan(nested, rr.comp.start, rr.comp.end);
          if (sp3[1] > sp3[0]) structure.push({ role: 'comp', start: W[sp3[0]].s, end: W[sp3[1] - 1].e, text: spanText(W, sp3[0], sp3[1]) });
        }
      }
      structure.sort(function (a, b) { return a.start - b.start; });
    }

    /* 未知词比例 */
    var unknown = 0;
    for (i = 0; i < W.length; i++) if (DR.pos.hasDict && !DR.pos.hasDict(W[i].w) && W[i].pos !== 'propn') unknown++;
    var multiFinite = false;
    for (i = 0; i < segs.length && !multiFinite; i++) {
      var fc = 0;
      for (var z = segs[i].start; z < segs[i].end; z++) {
        if (inSpan(nested, z)) { z = inSpan(nested, z).end - 1; continue; }
        if (isFiniteToken(W, z)) fc++;
      }
      if (fc > 1) multiFinite = true;
    }

    var hasVerb = false;
    for (i = 0; i < W.length; i++) if (W[i].pos === 'verb' || W[i].pos === 'aux' || W[i].pos === 'modal') { hasVerb = true; break; }

    out.tokens = W.map(function (t) {
      return { t: t.t, s: t.s, e: t.e, k: 'w', w: t.w, pos: t.pos, role: t.role || '', phrase: t.phrase || '', clause: t.clause || 0 };
    });
    out.clauses = clauses;
    out.structure = structure;
    out.notes = ctx.notes;
    out.summary = buildSummary(segResults, clauses, reliable, subjectClause);
    out.confidence = computeConfidence(W, segResults, nested, ctx.notes, reliable,
      { unknownRatio: W.length ? unknown / W.length : 0, multiFinite: multiFinite });
    if (!hasVerb) {
      out.confidence = Math.min(out.confidence, 0.3);
      if (!out.summary) out.summary = '未找到谓语动词（可能是省略句、标题或祈使句）';
    }
    if (!reliable && hasVerb) {
      out.confidence = Math.min(out.confidence, 0.4);
      var hasOther = false;
      for (i = 0; i < out.notes.length; i++) if (out.notes[i].kind === 'other') hasOther = true;
      if (!hasOther) note(out.notes, 'other', '主干识别不稳定', '句子结构复杂（多动词/从句嵌套/非谓语开头），主干标注已留空以免误导。', 0, Math.min(3, W.length), W);
    }
    return out;
  }

  function CLAUSE_TYPE_LABEL(t) {
    return ({ main: '主句', coord: '并列句', rel: '定语从句', sub: '从句', nonfinite: '非谓语短语' })[t] || '从句';
  }

  function addNonfiniteClauses(W, clauses) {
    var n = W.length, i;
    function covered(ch) {
      for (var k = 0; k < clauses.length; k++) {
        var c = clauses[k];
        if (c.type === 'main' || c.type === 'coord') continue;
        if (ch >= c.start && ch < c.end) return true;
      }
      return false;
    }
    for (i = 0; i < n; i++) {
      if (W[i].pos !== 'part' || W[i].w !== 'to' || W[i].role !== 'nonfin') continue;
      if (!W[i + 1] || W[i + 1].pos !== 'verb') continue;
      if (covered(W[i].s)) continue;
      clauses.push({ i: clauses.length, start: W[i].s, end: W[Math.min(n - 1, i + 1)].e, type: 'nonfinite', label: '非谓语短语（不定式）' });
    }
    for (i = 0; i < n; i++) {
      if (W[i].role !== 'nonfin' || (W[i].phrase !== 'GerP' && W[i].phrase !== 'PartP')) continue;
      if (covered(W[i].s)) continue;
      clauses.push({ i: clauses.length, start: W[i].s, end: W[i].e, type: 'nonfinite', label: W[i].phrase === 'GerP' ? '非谓语短语（动名词）' : '非谓语短语（分词）' });
      break;
    }
  }

  /* ---------------- 对外 ---------------- */
  function ready() { return !!(DR.pos && DR.pos.ready()); }
  function load() {
    if (!DR.pos) return Promise.reject(new Error('pos-missing'));
    return DR.pos.load();
  }

  function fallback(text, err) {
    var src = text == null ? '' : String(text);
    var words = [];
    try { words = DR.text.words(src); } catch (e2) { words = []; }
    return {
      text: src,
      tokens: words.map(function (w) { return { t: w.t, s: w.s, e: w.e, k: 'w', w: w.w, pos: 'noun', role: '', phrase: '', clause: 0 }; }),
      clauses: [], summary: '', structure: [], notes: [], confidence: 0.05,
      error: String(err && err.message || err)
    };
  }

  function sentence(text) {
    if (!ready()) throw new Error('not-ready');
    try {
      return analyzeText(text);
    } catch (err) {
      return fallback(text, err);
    }
  }

  DR.analyze = {
    load: load,
    ready: ready,
    sentence: sentence,
    legend: LEGEND,
    posZh: POS_ZH,
    /* 测试/集成用（不属于契约）：传 window.DR_POS 或 window.DR_POS.w 都行，返回词条数 */
    _installPos: function (d) {
      if (!DR.pos) return 0;
      if (d && d.w && typeof d.w === 'object') d = d.w;
      return DR.pos.install(d);
    },
    _tag: function (text) { return DR.pos.tag(buildWords(text).W); },
    _trace: function () { return lastTrace; }
  };
})();
