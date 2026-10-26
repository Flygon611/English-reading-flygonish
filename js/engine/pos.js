/* ============================================================================
 * pos.js — 词性标注引擎（内部模块，供 DR.analyze 使用）
 *
 * 分工：
 *   - 功能词（冠词/介词/连词/代词/助动词/情态动词/否定词/数词）由本文件的表维护，
 *     比语料可靠（契约 §4.2 允许）。
 *   - 实词查 js/data/pos-lex.js（window.DR_POS，ECDICT 生成），未收录时用词形规则兜底。
 *   - 再跑上下文改写规则，消解「名词↔动词」「be 是助动词还是系动词」「-ing/-ed 是分词还是形容词」等歧义。
 *
 * 契约关系：DR.pos 是 DR.analyze 的内部依赖，不属于对外契约；对外只有 DR.analyze。
 * 词性取值与 CONTRACT.md §4.2 一致：
 *   noun|verb|adj|adv|prep|conj|pron|det|num|aux|modal|part|interj|propn
 * 约定：否定的 not 记 adv；不定式标记 to 记 part；关系副词 when/where/why/how 记 adv。
 * ==========================================================================*/
(function () {
  'use strict';

  var DR = (window.DR = window.DR || {});

  var LEX_URL = 'js/data/pos-lex.js';
  var dict = null;          // word -> pos
  var loading = null;
  var ready = false;
  var installedAt = 0;

  /* 接受两种形态：{v:1,w:{...}}（window.DR_POS 本体）或直接词表 {word:'noun'} */
  function install(d) {
    if (d && d.w && typeof d.w === 'object' && !d.noun && !d.verb) d = d.w;
    dict = (d && typeof d === 'object') ? d : {};
    ready = true;
    installedAt = Object.keys(dict).length;
    return installedAt;
  }

  /* file:// 下用动态 <script>，禁止 fetch / ES module（契约 §1） */
  function load() {
    if (ready) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') { reject(new Error('no-document')); return; }
      var s = document.createElement('script');
      s.src = LEX_URL;
      s.async = true;
      s.onload = function () {
        if (window.DR_POS && window.DR_POS.w) { install(window.DR_POS.w); resolve(true); }
        else reject(new Error('pos-lex-invalid'));
      };
      s.onerror = function () { loading = null; reject(new Error('pos-lex-load-failed')); };
      (document.head || document.documentElement).appendChild(s);
    });
    return loading;
  }

  /* ---------------- 功能词表 ---------------- */
  function set(str) {
    var o = Object.create(null);
    str.split(/\s+/).forEach(function (w) { if (w) o[w] = 1; });
    return o;
  }
  function has(o, w) { return !!o[w]; }

  var PRON_ONLY = set(
    'i me mine myself we us ours ourselves you yours yourself yourselves he him she hers herself ' +
    'it its itself they them theirs themselves who whom whoever whomever somebody someone something ' +
    'anybody anyone anything everybody everyone everything nobody nothing none'
  );
  /* 只能作主语的代词（判定「代词 + 名词」为「主语 + 动词」时用） */
  var SUBJ_PRON = set('i you he she it we they who which that whoever whatever one');
  var POSS_DET = set('my your his her its our their whose');
  var DEMONSTR = set('this that these those');
  var WH_WORD = set('who whom whose which what whoever whatever whichever');
  var WH_ADV = set('when where why how');
  var ANTECEDENT_POS = { noun: 1, propn: 1, pron: 1, num: 1 };
  var QUANT = set('all some any both each every either neither no many much more most few little ' +
    'several enough such another other others own same half');
  var DET_ONLY = set('the a an every no another');
  var BE = set('be am is are was were been being');
  var HAVE = set('have has had having');
  var DO = set('do does did done doing');
  var AUX_ANY = set('be am is are was were been being have has had having do does did done doing');
  var MODAL = set('can could may might must shall should will would ought');
  var NEG_WORD = set('not');
  var CONTRACT_AUX = set("can't cannot couldn't won't wouldn't shouldn't mustn't mightn't needn't shan't " +
    "don't doesn't didn't isn't aren't wasn't weren't hasn't haven't hadn't oughtn't daren't");
  var CONTRACT_MODAL = set("can't cannot couldn't won't wouldn't shouldn't mustn't mightn't needn't shan't oughtn't daren't");
  var COORD_CONJ = set('and or but nor yet so');
  var SUB_CONJ = set('because although though if unless until till since when whenever while whereas ' +
    'whether as than that lest once where wherever before after if');
  var PREP = set(
    'in on at by for with without about against between among amongst through throughout during before ' +
    'after under over above below beneath behind beside besides beyond within into onto upon from to of ' +
    'off out up down along across around near past till toward towards via per despite except excepting ' +
    'regarding concerning including like unlike as than beyond underneath alongside amid amidst round ' +
    'opposite outside inside worth plus minus versus according'
  );
  var REL_PRON = set('who whom whose which that where when why');
  var INTERJ = set('oh ah wow hey yes yeah okay ok hello hi well please thanks thank');
  var NUM_WORD = set(
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen ' +
    'sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred ' +
    'thousand million billion trillion dozen'
  );
  var ORDINAL = set('first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth ' +
    'thirteenth nineteenth twentieth last next');
  /* 永远/优先当副词的高频词（词典常标成名词/形容词） */
  var TO_NOUN = set('school bed work church town hospital prison college university war sea market lunch dinner breakfast class court jail office home hand mind heart date order sleep rest peace last first');
  var ADV_FORCE = set(
    'abroad upstairs downstairs outdoors indoors overseas anyway however therefore moreover thus hence ' +
    'otherwise meanwhile instead indeed perhaps maybe probably certainly definitely actually really ' +
    'simply exactly especially particularly generally usually frequently rarely seldom hardly barely ' +
    'eventually recently lately immediately suddenly gradually completely entirely totally extremely ' +
    'fairly pretty rather quite almost nearly too also even only just still already yet ever never ' +
    'always often sometimes soon later then now today tomorrow yesterday ago here there everywhere ' +
    'somewhere anywhere nowhere away back forward backward together apart aside ahead home'
  );
  /* 形副同形词：句子末尾优先判副词 */
  var ADJ_ADV_DUAL = set('early late fast hard high low near far long little well better best worse worst more most less least');
  /* 动词短语小品词（out/up 等） */
  var PH_PARTICLE = set('out up down off away back in on over through along apart aside together forward backward');
  /* 语法化被动 / 形容词性 -ing 分词：系动词后仍当形容词 */
  var ADJ_PARTICIPLE = set(
    'interesting surprising exciting boring tiring amazing confusing disappointing frightening worrying ' +
    'satisfying charming encouraging embarrassing annoying fascinating terrifying relaxing rewarding ' +
    'shocking stunning convincing convincing convincing convincing convincing convincing'
  );
  var FINITE_BE = set('am is are was were been be');
  var LINKING = set('be am is are was were been being become becomes became becoming seem seems seemed ' +
    'appear appears appeared feel feels felt look looks looked sound sounds sounded smell smells smelled ' +
    'taste tastes tasted remain remains remained stay stays stayed grow grows grew grown turn turns turned ' +
    'prove proves proved keep keeps kept get gets got gotten go goes went gone come comes came');
  var PREP_COMPLEMENT = set(
    'depend rely insist consist belong look listen wait think refer apply deal cope agree approve ' +
    'disagree apologise apologize care hope attend participate focus concentrate comment result ' +
    'account aim point object sentence accuse blame praise thank remind warn inform'
  );
  var ABSTRACT_NOUN = set(
    'fact idea news belief possibility suggestion reason hope thought chance feeling doubt evidence ' +
    'argument claim conclusion decision opinion view notion principle rule statement theory truth ' +
    'assumption proposal promise report rumor rumour danger fear knowledge sign sense message ' +
    'impression requirement condition'
  );
  var IRREG_PP = set(
    'been born beaten become begun bent bet bid blown broken brought built burnt bought caught chosen ' +
    'clung come cost crept cut dealt done drawn dreamt drunk driven eaten fallen fed felt fought ' +
    'found flown forgotten forgiven frozen given gone got gotten grown hung heard held hidden hit hurt ' +
    'kept knelt known laid led left lent let lain lost made meant met paid put read risen ridden rung ' +
    'run said seen sold sent set shaken shone shot shown shut sung sunk sat slept slid spoken ' +
    'spent split spread sprung stood stolen stuck stung stunk sworn swept swelled taken taught ' +
    'torn told thought thrown understood undertaken upset woken worn won written wound'
  );
  var IRREG_PAST = set(
    'was were became began blew broke brought built bought caught chose came cost cut dealt did drew ' +
    'drank drove ate fell felt fought found flew forgot froze gave went grew hung heard held hid hit hurt ' +
    'kept knew laid led left lent let lay lost made meant met paid put read rode rang rose ran said saw ' +
    'sold sent set shook shone shot showed shut sang sank sat slept slid spoke spent split spread sprang ' +
    'stood stole stuck stung struck swore swept swam took taught tore told thought threw understood ' +
    'undertook upset woke wore won wrote'
  );

  var SUFFIX_NOUN = /(?:tion|sion|ment|ness|ity|ism|ist|ance|ence|ship|hood|age|ure|cy|dom|ery|ory)$/;
  var SUFFIX_ADJ = /(?:ous|ful|able|ible|ive|less|ical|ic|ish|esque|ant|ent|ary|ory|like)$/;
  var SUFFIX_VERB = /(?:ize|ise|ify|ate|en)$/;
  var SUFFIX_ADV = /(?:ly|wise|ward|wards)$/;
  var LY_EXCEPT = set(
    'only family likely early friendly lonely lovely daily weekly monthly yearly ugly silly holy reply ' +
    'supply apply rely belly jelly ally rally assembly italy july imply comply multiply fly dry fry try ' +
    'cry shy sky spy ply study bury carry hurry marry worry qualify simplify modify identify specify ' +
    'deny occupy satisfy empty busy easy'
  );

  function morphTag(w) {
    if (w.length > 4 && SUFFIX_ADV.test(w) && !has(LY_EXCEPT, w)) return 'adv';
    if (w.length > 4 && /ing$/.test(w)) return 'verb';
    if (w.length > 3 && /ed$/.test(w) && !/eed$/.test(w)) return 'verb';
    if (SUFFIX_NOUN.test(w)) return 'noun';
    if (SUFFIX_ADJ.test(w)) return 'adj';
    if (SUFFIX_VERB.test(w)) return 'verb';
    return 'noun';
  }

  function isNounish(p) { return p === 'noun' || p === 'propn' || p === 'num'; }
  function isAuxWordWord(w) {
    return has(AUX_ANY, w) || has(MODAL, w) || has(CONTRACT_AUX, w) || /^(the|a|an)$/.test(w);
  }

  /* 词典候选词性：多词性编码为 "noun|verb" */
  function candsOf(w) {
    var v = dict ? dict[w] : '';
    return v ? v.split('|') : [];
  }
  function can(w, pos) {
    var c = candsOf(w);
    for (var i = 0; i < c.length; i++) if (c[i] === pos) return true;
    return false;
  }
  /* 屈折形式还原原形再判动词（works → work） */
  function stemCanVerb(w) {
    var bases = [];
    if (/ies$/.test(w)) bases.push(w.slice(0, -3) + 'y');
    if (/es$/.test(w)) bases.push(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) bases.push(w.slice(0, -1));
    if (/ed$/.test(w)) { bases.push(w.slice(0, -2)); bases.push(w.slice(0, -1)); }
    for (var i = 0; i < bases.length; i++) if (can(bases[i], 'verb')) return true;
    return false;
  }
  function canVerbish(w) { return can(w, 'verb') || stemCanVerb(w); }

  /* 原始标签：函数词的「强」标签 + 实词查表/词形。上下文相关词在此先给一个初值。 */
  function rawTag(w, orig) {
    if (has(NEG_WORD, w)) return 'adv';
    if (has(WH_ADV, w)) return 'adv';
    if (has(PRON_ONLY, w)) return 'pron';
    if (has(POSS_DET, w)) return 'det';
    if (has(MODAL, w)) return 'modal';
    if (has(CONTRACT_MODAL, w)) return 'modal';
    if (has(CONTRACT_AUX, w)) return 'aux';
    if (has(AUX_ANY, w)) return 'aux';        // 之后可能翻成 verb
    if (has(COORD_CONJ, w)) return 'conj';
    if (has(INTERJ, w)) return 'interj';
    if (has(NUM_WORD, w)) return 'num';
    if (has(ORDINAL, w)) return 'adj';
    if (has(DET_ONLY, w)) return 'det';
    if (has(PREP, w)) return 'prep';          // 之后可能校正为 conj / part / adv
    if (has(SUB_CONJ, w)) return 'conj';
    var p = dict ? dict[w] : '';
    if (p) {
      p = p.split('|')[0];
      if (p === 'aux' || p === 'modal') return 'verb';
      if (p === 'propn') return /^[A-Z]/.test(orig || '') ? 'propn' : 'noun';
      return p;
    }
    if (orig && /^[A-Z]/.test(orig)) return 'propn';
    return morphTag(w);
  }

  /* ---------------- 上下文解析 ---------------- */
  function resolveThat(words, raw, i) {
    var n = words.length;
    var nw = i + 1 < n ? words[i + 1].w : '';
    var nt = i + 1 < n ? raw[i + 1] : '';
    var pw = i > 0 ? words[i - 1].w : '';
    var pt = i > 0 ? raw[i - 1] : '';
    var nextVP = nt === 'verb' || nt === 'aux' || nt === 'modal' ||
      (nt === 'adj' && /(?:ed|ing)$/.test(nw));
    var nextNP = isNounish(nt) || (nt === 'adj' && !nextVP);
    var prevNoun = pt === 'noun' || pt === 'propn';
    if (nextNP && !prevNoun) return 'det';                    // that book
    if (prevNoun) {
      if (nt === 'det') return 'pron';                        // the report that the committee released
      if (has(ABSTRACT_NOUN, pw) && (nt === 'pron' || nt === 'noun') && !nextVP) return 'conj'; // the fact that he came
      return 'pron';
    }
    return 'conj';                                            // I know that he …
  }

  function resolveQuant(words, raw, i) {
    var w = words[i].w;
    var n = words.length;
    var nt = i + 1 < n ? raw[i + 1] : '';
    var nw = i + 1 < n ? words[i + 1].w : '';
    var pt = i > 0 ? raw[i - 1] : '';
    if (w === 'no') return (isNounish(nt) || nt === 'adj' || can(nw, 'noun')) ? 'det' : 'adv';
    if (w === 'more' || w === 'most' || w === 'much' || w === 'less' || w === 'least') {
      if (isNounish(nt) || nt === 'adj' || nt === 'adv') return 'adv';
      return 'pron';
    }
    if (isNounish(nt) || nt === 'adj' || nt === 'verb' || nt === 'det' || nt === 'propn') {
      if (nt === 'verb' && (pt === 'det' || pt === 'prep' || pt === 'num')) return 'pron';
      return 'det';
    }
    return 'pron';
  }

  /* 介词 / 从属连词 / 不定式标记 */
  function resolvePrepConj(words, raw, i) {
    var w = words[i].w;
    var n = words.length;
    var nt = i + 1 < n ? raw[i + 1] : '';
    var nw = i + 1 < n ? words[i + 1].w : '';
    var pt = i > 0 ? raw[i - 1] : '';

    if (w === 'to') {
      if (nt === 'verb' || nt === 'aux' || nt === 'modal' || has(BE, nw) || has(HAVE, nw) || has(DO, nw)) return 'part';
      /* 固定介词短语：go to school / to bed / to work … */
      if (TO_NOUN[nw]) return 'prep';
      if (canVerbish(nw)) return 'part';
      /* to + 名词型动词 + 宾语（to practice every day）→ 不定式 */
      if (i + 2 < words.length) {
        var nn2 = words[i + 2].w, np2 = raw[i + 2];
        if (np2 === 'det' || np2 === 'pron' || np2 === 'num' || np2 === 'adv' || np2 === 'adj') return 'part';
      }
      return 'prep';
    }
    if (w === 'because' || w === 'although' || w === 'though' || w === 'unless' || w === 'whereas' || w === 'whether' || w === 'lest') return 'conj';
    if (w === 'if' || w === 'once') return 'conj';
    if (w === 'than' || w === 'while') return 'conj';
    if (w === 'as' || w === 'like' || w === 'before' || w === 'after' || w === 'since' || w === 'until' || w === 'till' || w === 'while') {
      if (nt === 'pron' && w !== 'like') return 'conj';
      if (nt === 'det' || nt === 'num' || nt === 'adj' || isNounish(nt) || nt === 'prep') return 'prep';
      if (nt === 'verb' || nt === 'aux' || nt === 'modal' || nt === 'adv') return 'conj';
      return has(SUB_CONJ, w) ? 'conj' : 'prep';
    }
    return 'prep';
  }

  function resolveAuxTag(words, raw, i) {
    var n = words.length;
    var w = words[i].w;
    var nw = i + 1 < n ? words[i + 1].w : '';
    if (has(NEG_WORD, nw)) {
      var nn = i + 2 < n ? raw[i + 2] : '';
      return (nn === 'verb') ? 'aux' : 'verb';
    }
    if (raw[i + 1] === 'aux') return 'aux';
    if (raw[i + 1] === 'verb') return 'aux';
    return 'verb';
  }

  /* ---------------- 主流程 ---------------- */
  function tag(words) {
    var n = words.length;
    var out = new Array(n);
    var raw = new Array(n);
    var i, w, orig;

    for (i = 0; i < n; i++) raw[i] = rawTag(words[i].w, words[i].t);

    for (i = 0; i < n; i++) {
      w = words[i].w;
      orig = words[i].t;
      var nt = i + 1 < n ? raw[i + 1] : '';
      var nw = i + 1 < n ? words[i + 1].w : '';
      var pt = i > 0 ? raw[i - 1] : '';
      var pw = i > 0 ? words[i - 1].w : '';
      var p;

      if (w === 'that') p = resolveThat(words, raw, i);
      else if (has(DEMONSTR, w)) p = (isNounish(nt) || nt === 'adj' || nt === 'num') ? 'det' : 'pron';
      else if (has(WH_ADV, w)) p = 'adv';
      else if (has(WH_WORD, w)) {
        if (w === 'what' && i === 0) p = 'pron';               // What matters is …（名词性从句）
        else if (w === 'whom' && i > 0 && ANTECEDENT_POS[raw[i - 1]]) p = 'pron';
        else if ((w === 'which' || w === 'whose') && i > 0 && ANTECEDENT_POS[raw[i - 1]]) {
          /* 先行词 + which：后接动词/助动词 → 关系代词；后接名词 → 限定词（which meaning） */
          if (canVerbish(nw) || nt === 'verb' || nt === 'aux' || nt === 'modal') p = 'pron';
          else if (isNounish(nt) || nt === 'adj') p = 'det';
          else p = 'pron';
        }
        else p = (w === 'whose' || w === 'what' || w === 'which' || w === 'whatever' || w === 'whichever')
          ? ((isNounish(nt) || nt === 'adj') ? 'det' : 'pron') : 'pron';
      } else if ((w === 'either' || w === 'neither') && nt === 'pron') p = 'conj';
      else if (has(QUANT, w)) p = resolveQuant(words, raw, i);
      else if (has(POSS_DET, w)) p = (isNounish(nt) || nt === 'adj' || nt === 'num' || (nt === 'verb' && !has(NEG_WORD, nw))) ? 'det' : 'pron';
      else if (has(PREP, w) || has(SUB_CONJ, w)) p = resolvePrepConj(words, raw, i);
      else if (has(AUX_ANY, w) || has(CONTRACT_AUX, w)) p = resolveAuxTag(words, raw, i);
      else if (w === 'there' || w === 'here') {
        p = (nt === 'verb' || nt === 'aux' || nt === 'modal') ? 'pron' : 'adv';
      } else p = raw[i];

      out[i] = p;
    }
    /* 句中（非句首）大写词 → 专有名词：Sunday、April */
    for (i = 1; i < n; i++) {
      if (/^[A-Z][a-z]/.test(words[i].t) && !has(INTERJ, words[i].w) && words[i].w !== 'i' && !isAuxWordWord(words[i].w)) {
        if (out[i] === 'noun' || out[i] === 'propn') out[i] = 'propn';
      }
    }

    /* 上下文改写（两遍） */
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < n; i++) rewrite(words, out, i);
    }
    /* be/have/do 最终定性：助动词 or 实义动词 */
    for (i = 0; i < n; i++) {
      w = words[i].w;
      if (has(AUX_ANY, w) || has(CONTRACT_AUX, w)) out[i] = auxOrVerb(words, out, i);
    }
    /* 第三遍：修正上一遍带来的小问题（-ed/-ing、副词位置） */
    for (i = 0; i < n; i++) rewrite(words, out, i);
    for (i = n - 1; i >= 0; i--) rewrite(words, out, i);
    return out;
  }

  function isBeish(words, out, j) {
    if (j < 0) return false;
    return has(BE, words[j].w) || out[j] === 'aux' || /(?:be|is|are|was|were|been|being|has|have|had)$/.test(words[j].w);
  }

  function auxOrVerb(words, out, i) {
    var n = words.length;
    var w = words[i].w;
    if (w === 'having') return 'verb';
    var j = i + 1;
    while (j < n && out[j] === 'adv' && has(NEG_WORD, words[j].w)) j++;   // 跳过 not
    if (j >= n) return 'verb';
    var np = out[j];
    var nw2 = words[j].w;
    if (w === 'being' && (i === 0 || np !== 'verb')) return 'verb';
    if (has(BE, w) && (/(?:ing|ed)$/.test(nw2) || has(IRREG_PP, nw2))) return 'aux';
    if (np === 'verb' || np === 'aux') return 'aux';
    /* have/do + 主语 + 动词：疑问句/倒装里是助动词（Have you ever visited / Did he go） */
    if ((has(HAVE, w) || has(DO, w)) && (np === 'pron' || np === 'det' || np === 'noun' || np === 'propn' || np === 'num')) {
      for (var k = j; k < n && k <= j + 5; k++) {
        if (out[k] === 'verb') return 'aux';
        if (out[k] === 'prep' || out[k] === 'conj') break;
      }
    }
    return 'verb';
  }

  function rewrite(words, out, i) {
    var w = words[i].w;
    var n = words.length;
    var p = out[i];
    var pt = i > 0 ? out[i - 1] : '';
    var nt = i + 1 < n ? out[i + 1] : '';
    var nw = i + 1 < n ? words[i + 1].w : '';
    var pw = i > 0 ? words[i - 1].w : '';
    var isAuxWord = has(AUX_ANY, w) || has(CONTRACT_AUX, w) || has(MODAL, w);
    var subjPron = has(SUBJ_PRON, pw);

    /* 0. not yet / and yet：yet 作副词 */
    if (w === 'yet' && (pw === 'not' || pw === 'have' || pw === 'has' || pw === 'had')) { out[i] = 'adv'; return; }
    /* 0b. I first began / he next tried：序数词在主语和动词之间是副词 */
    if (has(ORDINAL, w) && (pt === 'pron' || pt === 'noun' || pt === 'propn') && (nt === 'verb' || nt === 'aux' || nt === 'modal')) {
      out[i] = 'adv'; return;
    }
    /* 1. 冠词/数词/形容词后的动词 → 名词（the run / a report / a rare skill），但 be/do/have 等不改 */
    if (p === 'verb' && (pt === 'det' || pt === 'num' || pt === 'adj') && !isAuxWord && !/ing$|ed$/.test(w)) {
      if (pt !== 'adj' || can(w, 'noun')) { out[i] = 'noun'; return; }
    }
    /* 2. 冠词后的 -ing/-ed 分词 → 形容词/名词 */
    if (p === 'verb' && pt === 'det' && /ing$/.test(w)) {
      out[i] = (dict && dict[w] === 'noun') ? 'noun' : 'adj'; return;
    }
    if (p === 'verb' && pt === 'det' && /ed$/.test(w)) { out[i] = 'adj'; return; }
    /* 3. 情态动词 / 助动词 do·did 后 → 动词 */
    if ((p === 'noun' || p === 'adj' || p === 'propn') && (pt === 'modal')) { out[i] = 'verb'; return; }
    if ((p === 'noun' || p === 'adj') && pt === 'aux' && /^(do|does|did)$/.test(pw)) { out[i] = 'verb'; return; }
    /* 4. 不定式 to 后 → 动词 */
    if (p === 'noun' && pt === 'part' && pw === 'to') { out[i] = 'verb'; return; }
    /* 5. 主语代词后 → 动词（I thought / who lives / you help / he left） */
    if ((p === 'noun' || p === 'propn' || p === 'adj') && pt === 'pron' && subjPron &&
      !has(ORDINAL, w) && !has(ADV_FORCE, w)) {
      if (p === 'adj' || p === 'noun' || p === 'propn' || canVerbish(w)) { out[i] = 'verb'; return; }
    }
    /* 6. 主语代词后直接跟形容词 → 动词（he left / who surprised）；排除 first/next 等 */
    if (p === 'adj' && pt === 'pron' && subjPron && !has(ORDINAL, w) && !has(ADV_FORCE, w)) { out[i] = 'verb'; return; }
    /* 7. be/have/having + 分词：-ed/-ing 形容词 → 动词（was written / is raining / having finished） */
    if (p === 'adj' && (pt === 'aux' || pt === 'verb') && /(?:ed|ing)$/.test(w) || (p === 'adj' && (pt === 'aux' || pt === 'verb') && has(IRREG_PP, w))) {
      if (pt === 'aux' || pt === 'verb') {
        var beFinite = has(FINITE_BE, pw) || has(BE, pw) || /^(been|being|having|has|have|had)$/.test(pw) || out[i - 1] === 'aux';
        if (beFinite) {
          if (!(has(ADJ_PARTICIPLE, w) && /ing$/.test(w) && !has(HAVE, pw))) { out[i] = 'verb'; return; }
        }
      }
    }
    /* 8. 名词 + to + 动词（thought to be …）→ 名词其实是过去分词 */
    if (p === 'noun' && nt === 'part' && pt !== 'det' && pt !== 'prep' && pt !== 'adj') {
      var nn = i + 2 < n ? out[i + 2] : '';
      if (nn === 'verb' || i + 2 >= n) { out[i] = 'verb'; return; }
    }
    /* 9. 形容词在移动词后 → 副词（went home early / works hard） */
    if (p === 'adj' && has(ADJ_ADV_DUAL, w) && (pt === 'verb' || pt === 'aux' || pt === 'prep' || pt === 'pron')) {
      if (i === n - 1 || nt === 'conj' || nt === 'prep' || nt === 'pron' || nt === 'det' || nt === '' || nt === 'adv') { out[i] = 'adv'; return; }
    }
    /* 10. 介词在句末/短语小品词 → 副词（went out / pick it up） */
    if (p === 'prep' && has(PH_PARTICLE, w) && ((i === n - 1) || nt === '' || nt === 'conj' || nt === 'adv' || nt === 'prep' || nt === 'verb')) {
      out[i] = 'adv'; return;
    }
    /* 11. 副词强制表：词典常误标名词/形容词的高频副词 */
    if ((p === 'noun' || p === 'adj') && has(ADV_FORCE, w) && pt !== 'det') {
      if (!((pt === 'prep' || pt === 'adj') && (isNounish(nt) || nt === 'adj'))) { out[i] = 'adv'; return; }
    }
    /* 12. 小写形式在句中 → 普通名词（词典标 propn 也不作数） */
    if (p === 'propn' && words[i].t && !/^[A-Z]/.test(words[i].t)) { out[i] = 'noun'; return; }
    /* 13. 冠词 + 专有名词 → 普通名词（the union） */
    if (p === 'propn' && pt === 'det') { out[i] = 'noun'; return; }
    /* 14. 祈使句：句首/Please 后 + 名词短语 → 动词 */
    if ((p === 'adj' || p === 'noun') && (i === 0 || pt === 'interj') && nt === 'det' && !isAuxWord) {
      out[i] = 'verb'; return;
    }
    /* 14. 句首名词（复数同形）+ 动词/助动词 → 名词主语（Coats go …） */
    if (p === 'verb' && i === 0 && can(w, 'noun') && (nt === 'verb' || nt === 'aux' || nt === 'modal' || nt === 'adv')) {
      out[i] = 'noun'; return;
    }
    /* 14a. 句首动名词主语（Reading novels helps …） */
    if (p === 'noun' && /ing$/.test(w) && i === 0 && (nt === 'noun' || nt === 'propn' || nt === 'det')) {
      out[i] = 'verb'; return;
    }
    /* 14b. be/have + -ing/-ed 名词 → 分词动词（was shining） */
    if ((p === 'noun' || p === 'propn') && pt === 'aux' && (/(?:ing|ed)$/.test(w) || has(IRREG_PP, w))) {
      out[i] = 'verb'; return;
    }
    /* 14c. 名词候选 + 助动词/系动词 → 它是名词（the only sounds are / the only sounds is） */
    if (p === 'verb' && can(w, 'noun') &&
      (nt === 'aux' || nt === 'modal' || (nt === 'verb' && /^(am|is|are|was|were|been|being|have|has|had|do|does|did|will|can|would|could|should|may|might|must)$/.test(words[i + 1] ? words[i + 1].w : '')) ||
        (nt === 'verb' && (pt === 'det' || pt === 'adj' || pt === 'adv' || pt === 'num')))) {
      out[i] = 'noun'; return;
    }
    /* 14d. 名词后接限定词 → 祈使动词（… chair, pick a paragraph） */
    if (p === 'noun' && nt === 'det' && (pt === 'noun' || pt === 'propn') && canVerbish(w)) {
      out[i] = 'verb'; return;
    }
    /* 15. 名词 + 形容词 → 第二个是谓语动词（the soup tastes delicious / the news made everyone） */
    if (p === 'adj' && pt === 'noun' && (nt === 'det' || nt === 'pron' || nt === 'adv' || nt === 'prep' || nt === '')) {
      if (canVerbish(w) || /ed$/.test(w)) { out[i] = 'verb'; return; }
    }
    /* 15b. 名词 + 不规则过去式 → 谓语（the news made everyone） */
    if ((p === 'adj' || p === 'noun') && (pt === 'noun' || pt === 'pron' || pt === 'propn') && has(IRREG_PAST, w)) {
      out[i] = 'verb'; return;
    }
    /* 15c. 动词 + -ed 形容词 + 宾语 → 谓语（released surprised everyone） */
    if (p === 'adj' && pt === 'verb' && /ed$/.test(w) && nt === 'pron') {
      out[i] = 'verb'; return;
    }
    /* 15d. 实义动词 + 名词（可作名词）+ 限定词/句末 → 宾语（read books every day） */
    if (p === 'verb' && pt === 'verb' && can(w, 'noun') && !isAuxWord &&
      (nt === 'det' || nt === 'adv' || nt === 'prep' || nt === '' || nt === 'conj' || nt === 'num')) {
      out[i] = 'noun'; return;
    }
    /* 15e. 名词 + 名词 + 动词 → 第二个名词是谓语（Reading novels helps improve） */
    if (p === 'noun' && (pt === 'noun' || pt === 'propn') && nt === 'verb' && canVerbish(w)) {
      out[i] = 'verb'; return;
    }
    /* 16. 名词 + 名词 + 副词/形容词 → 后一个名词是谓语动词（whose son studies abroad） */
    if (p === 'noun' && (pt === 'noun' || pt === 'propn') && (nt === 'adv' || nt === 'adj')) {
      if (canVerbish(w)) { out[i] = 'verb'; return; }
    }
    /* 16b. 动词 + 名词（有动词候选）+ 形容词/句末 → 名词其实是谓语（come remains uncertain） */
    if (p === 'noun' && pt === 'verb' && canVerbish(w) && (nt === 'adj' || nt === '' || nt === 'adv' || nt === 'prep')) {
      out[i] = 'verb'; return;
    }
    /* 17. 副词 + 名词 + 介词 → 名词是动词（works at） */
    if (p === 'noun' && pt === 'adv' && (nt === 'prep' || nt === 'det')) {
      if (canVerbish(w) || stemCanVerb(w)) { out[i] = 'verb'; return; }
    }
    /* 17b. the previous one / a simpler one：one 是代词 */
    if (w === 'one' && (pt === 'det' || pt === 'adj') && (nt === '' || nt === 'conj' || nt === 'prep' || nt === 'pron')) {
      out[i] = 'pron'; return;
    }
    /* 18. 情态词 / 不定式 to 后，只要词典有动词候选 → 动词（to exercise / can report） */
    if ((p === 'noun' || p === 'adj' || p === 'propn') && (pt === 'modal' || (pt === 'part' && pw === 'to'))) {
      if (canVerbish(w)) { out[i] = 'verb'; return; }
    }
    /* 19. 冠词 + X + 名词：X 只有形容词候选时取形容词（a young scientist） */
    if (p === 'noun' && (pt === 'det' || pt === 'num') && (nt === 'noun' || nt === 'adj' || nt === 'propn')) {
      if (can(w, 'adj') && (!can(w, 'noun') || nt === 'noun' || nt === 'propn')) { out[i] = 'adj'; return; }
    }
  }

  /* ---------------- 对外（内部）接口 ---------------- */
  DR.pos = {
    load: load,
    ready: function () { return ready; },
    install: install,
    tag: tag,
    dictTag: function (w) { return dict ? (dict[w] || '') : ''; },
    hasDict: function (w) { return !!(dict && dict[w]); },
    size: function () { return installedAt; },
    lex: {
      PRON_ONLY: PRON_ONLY, SUBJ_PRON: SUBJ_PRON, POSS_DET: POSS_DET, DEMONSTR: DEMONSTR,
      WH_WORD: WH_WORD, WH_ADV: WH_ADV, QUANT: QUANT, DET_ONLY: DET_ONLY, BE: BE, HAVE: HAVE,
      DO: DO, AUX_ANY: AUX_ANY, MODAL: MODAL, NEG_WORD: NEG_WORD, CONTRACT_AUX: CONTRACT_AUX,
      COORD_CONJ: COORD_CONJ, SUB_CONJ: SUB_CONJ, PREP: PREP, REL_PRON: REL_PRON, INTERJ: INTERJ,
      NUM_WORD: NUM_WORD, ORDINAL: ORDINAL, ADV_FORCE: ADV_FORCE, ADJ_ADV_DUAL: ADJ_ADV_DUAL,
      PH_PARTICLE: PH_PARTICLE, ADJ_PARTICIPLE: ADJ_PARTICIPLE, LINKING: LINKING,
      PREP_COMPLEMENT: PREP_COMPLEMENT, ABSTRACT_NOUN: ABSTRACT_NOUN, IRREG_PP: IRREG_PP,
      IRREG_PAST: IRREG_PAST
    }
  };
})();
