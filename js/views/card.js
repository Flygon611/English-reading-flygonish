/* 检查器卡片：单词卡 / 句子成分卡 / 空状态。阅读页、词库页、生词本共用。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var h = function () { return DR.dom.h.apply(null, arguments); };
  var icon = function (n, s) { return DR.ui.icon(n, s); };
  var toast = function (m, o) { return DR.ui.toast(m, o); };
  var q = function (s) { return DR.dom.q(s); };

  var FALLBACK_LEGEND = [
    { id: 'subj', zh: '主语', color: 'var(--role-subj)' },
    { id: 'pred', zh: '谓语', color: 'var(--role-pred)' },
    { id: 'obj', zh: '宾语', color: 'var(--role-obj)' },
    { id: 'comp', zh: '表语/补语', color: 'var(--role-comp)' },
    { id: 'adv', zh: '状语', color: 'var(--role-adv)' },
    { id: 'attr', zh: '定语', color: 'var(--role-attr)' }
  ];

  function legend() {
    var L = (window.DR && DR.analyze && DR.analyze.legend) ? DR.analyze.legend : FALLBACK_LEGEND;
    return L && L.length ? L : FALLBACK_LEGEND;
  }
  function roleZh(role) {
    var l = legend().filter(function (x) { return x.id === role; })[0];
    return l ? l.zh : '';
  }
  function posZh(pos) {
    var m = (DR.analyze && DR.analyze.posZh) || {
      noun: '名词', verb: '动词', adj: '形容词', adv: '副词', prep: '介词', conj: '连词',
      pron: '代词', det: '限定词', num: '数词', aux: '助动词', modal: '情态动词',
      part: '助词', interj: '感叹词', propn: '专有名词', punct: '标点'
    };
    return m[pos] || pos || '';
  }

  /* 把文本里第一次出现的 needles 之一包成 <mark> */
  function markFirst(text, needles) {
    var frag = document.createDocumentFragment();
    var src = String(text || '');
    var hit = null, hitIdx = -1;
    (needles || []).forEach(function (n) {
      if (!n) return;
      var re = new RegExp('\\b' + String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      var m = re.exec(src);
      if (m && (hitIdx < 0 || m.index < hitIdx)) { hitIdx = m.index; hit = m[0]; }
    });
    if (hitIdx < 0) { frag.appendChild(document.createTextNode(src)); return frag; }
    frag.appendChild(document.createTextNode(src.slice(0, hitIdx)));
    frag.appendChild(h('mark', { class: 'ctx-mark' }, hit));
    frag.appendChild(document.createTextNode(src.slice(hitIdx + hit.length)));
    return frag;
  }

  function speak(text, isWord) {
    if (!DR.tts.hasVoice()) {
      toast('系统里没有可用的英语语音，可以在系统设置里安装', { kind: 'warn' });
      return;
    }
    DR.tts.speak(text, { word: !!isWord });
  }

  function tagsFor(entry) {
    var box = h('div', { class: 'tags' });
    (entry.packs || []).forEach(function (p) {
      var b = DR.ui.packBadge(p);
      if (b) box.appendChild(b);
    });
    if (!entry.packs || !entry.packs.length) {
      if (entry.source === 'full') box.appendChild(h('span', { class: 'tag tag--out' }, '超纲 / 词库外'));
      else box.appendChild(h('span', { class: 'tag tag--none' }, '未收录'));
    }
    if (entry.lvl) box.appendChild(h('span', { class: 'tag tag--lvl', title: '英语言难度 1–4' }, '难度 ' + entry.lvl));
    return box;
  }

  /* 按词性把释义拆成几段，避免把每个「；」都切碎 */
  function defLines(zh) {
    var s = String(zh || '').trim();
    if (!s) return [];
    s = s.replace(/(^|\s)((?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|aux|int|abbr|phr|pl)\.\s?)/gi, '\n$2');
    return s.split('\n').map(function (t) { return t.replace(/^[；;,\s]+|[；;,\s]+$/g, '').trim(); }).filter(Boolean);
  }

  /* ---------------- 单词卡 ---------------- */
  function wordCard(entry, opts) {
    opts = opts || {};
    var raw = opts.raw || (entry && entry.w) || '';
    var isUnknown = !entry;
    if (isUnknown) entry = { w: raw, ipa: '', zh: '', ex: '', exZh: '', packs: [], forms: [], source: 'none', mask: 0 };
    var key = DR.store.bookKey(entry, raw);
    var item = DR.store.getItem(key);
    var shown = raw || entry.w;
    var lemmaShown = entry.w && entry.w.toLowerCase() !== String(raw).toLowerCase() ? entry.w : '';

    function rerender() {
      var next = wordCard(entry, opts);
      if (opts.onRerender) opts.onRerender(next);
      else DR.card.setInspector(next);
      if (opts.onChanged) opts.onChanged();
    }

    var el = h('section', { class: 'card card--word', id: 'word-card', 'aria-label': '单词卡' });

    var head = h('div', { class: 'card__top' },
      h('p', { class: 'eyebrow' }, 'WORD · 单词'),
      h('button', {
        class: 'icon-btn card__close', type: 'button', 'aria-label': '关闭检查器',
        onclick: function () {
          if (opts.onClose) opts.onClose();
          else DR.card.closeInspector();
        }
      }, '×')
    );
    el.appendChild(head);

    var titleRow = h('div', { class: 'word-head' },
      h('h2', { class: 'word', id: 'word-card-word' }, shown),
      h('button', {
        class: 'icon-btn icon-btn--round', id: 'btn-speak-word', type: 'button',
        title: '朗读单词', 'aria-label': '朗读单词',
        onclick: function () { speak(entry.w || shown, true); }
      }, icon('speaker', 18))
    );
    el.appendChild(titleRow);

    var sub = h('p', { class: 'word-sub' });
    if (entry.ipa) sub.appendChild(h('span', { class: 'ipa' }, '/' + entry.ipa + '/'));
    if (specialHint(shown)) sub.appendChild(h('span', { class: 'word-sub__hint' }, specialHint(shown)));
    if (sub.childNodes.length) el.appendChild(sub);

    el.appendChild(tagsFor(entry));

    if (isUnknown) {
      el.appendChild(h('p', { class: 'defs defs--empty' },
        '本地词库没有收录这个词。可能是人名、专名、缩写或超出词库的专业词；词形还原已经试过，仍然没有命中。'));
      var affs = DR.dict.affixHints(raw);
      if (affs.length) {
        var box = h('div', { class: 'affix' }, h('p', { class: 'eyebrow' }, '词缀线索'));
        affs.forEach(function (a) {
          box.appendChild(h('p', { class: 'affix__row' },
            h('span', { class: 'affix__a' }, a.a),
            h('span', { class: 'affix__zh' }, a.zh),
            a.note ? h('span', { class: 'affix__note' }, a.note) : null
          ));
        });
        el.appendChild(box);
      }
    } else {
      var defs = h('div', { class: 'defs' });
      defLines(entry.zh).slice(0, 5).forEach(function (d) {
        defs.appendChild(h('p', {}, d));
      });
      if (!entry.zh) defs.appendChild(h('p', { class: 'muted' }, '（这个词条没有中文释义）'));
      el.appendChild(defs);

      if (lemmaShown) {
        var lemma = h('p', { class: 'lemma-line' }, '原形：');
        lemma.appendChild(h('button', {
          class: 'link', type: 'button', dataset: { lemma: entry.w },
          onclick: function () { if (opts.onLemma) opts.onLemma(entry.w); }
        }, entry.w));
        el.appendChild(lemma);
      }

      if (entry.forms && entry.forms.length) {
        el.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'kv__k' }, '词形'),
          h('span', { class: 'kv__v' }, entry.forms.slice(0, 8).join(' · '))
        ));
      }
      if (entry.ex) {
        var ex = h('blockquote', { class: 'example' });
        ex.appendChild(h('p', {}, entry.ex));
        if (entry.exZh) ex.appendChild(h('p', { class: 'example__zh' }, entry.exZh));
        el.appendChild(ex);
      }
    }

    if (opts.context && opts.context.text) {
      var ctx = h('div', { class: 'context' },
        h('p', { class: 'eyebrow' }, 'IN CONTEXT · 在文中'),
        h('p', { class: 'context__text' }, markFirst(opts.context.text, [raw, entry.w]))
      );
      if (opts.context.title) ctx.appendChild(h('p', { class: 'context__src' }, '— ' + opts.context.title));
      el.appendChild(ctx);
    }

    var foot = h('footer', { class: 'card__foot' });
    if (opts.onAnalyzeSentence) {
      foot.appendChild(h('button', {
        class: 'btn', type: 'button', id: 'btn-analyze-sentence',
        title: '分析这句话的主干与语法点',
        onclick: function () { if (opts.onAnalyzeSentence) opts.onAnalyzeSentence(); }
      }, '看这句成分'));
    }
    var addBtn = h('button', {
      class: 'btn ' + (item ? 'btn--danger-ghost' : 'btn--primary'),
      id: 'btn-add-word', type: 'button',
      onclick: function () {
        if (DR.store.getItem(key)) {
          DR.store.removeItem(key);
          toast('已移出生词本：' + (entry.w || shown));
        } else {
          DR.store.addLookup(entry, opts.context, { silent: false });
          toast('已收入生词本：' + (entry.w || shown));
        }
        rerender();
      }
    }, item ? '移出生词本' : '收入生词本');
    foot.appendChild(addBtn);

    if (!isUnknown) {
      var known = item && item.status === 'known';
      foot.appendChild(h('button', {
        class: 'btn btn--ghost', id: 'btn-known-word', type: 'button',
        onclick: function () {
          if (!DR.store.getItem(key)) DR.store.addLookup(entry, opts.context, { silent: true });
          var nowKnown = DR.store.getItem(key).status === 'known';
          DR.store.setStatus(key, nowKnown ? 'learning' : 'known');
          toast(nowKnown ? '已取消「已掌握」' : '标记为已掌握');
          rerender();
        }
      }, known ? '取消已掌握' : '标记已掌握'));
    }
    el.appendChild(foot);

    if (item) {
      var meta = h('p', { class: 'card__meta' },
        '生词本 · 第 ' + (item.count || 1) + ' 次查询 · ' + DR.dom.relTime(item.lastAt || item.firstAt || Date.now()) +
        (item.status === 'known' ? ' · 已掌握' : (item.status === 'learning' ? ' · 学习中' : ' · 新词')));
      el.appendChild(meta);
    } else {
      el.appendChild(h('p', { class: 'card__meta muted' }, '查词会自动收入生词本，可在设置里关闭。'));
    }
    return el;
  }

  function specialHint(w) {
    var s = String(w || '');
    if (/^[A-Z][A-Z0-9]{1,}$/.test(s)) return '全大写，可能是缩写';
    if (/[A-Z]/.test(s.slice(1)) && /^[A-Z]/.test(s)) return '可能为专有名词';
    return '';
  }

  /* ---------------- 句子成分卡 ---------------- */
  function sentenceCard(text, result, opts) {
    opts = opts || {};
    var el = h('section', { class: 'card card--sentence', id: 'sentence-card', 'aria-label': '句子成分' });
    el.appendChild(h('div', { class: 'card__top' },
      h('p', { class: 'eyebrow' }, 'SENTENCE · 句子'),
      h('div', { class: 'card__top-actions' },
        h('button', {
          class: 'icon-btn', type: 'button', title: '朗读句子', 'aria-label': '朗读句子',
          onclick: function () { speak(text, false); }
        }, icon('speaker', 18)),
        h('button', {
          class: 'icon-btn card__close', type: 'button', 'aria-label': '关闭检查器',
          onclick: function () { DR.card.closeInspector(); if (opts.onClose) opts.onClose(); }
        }, '×')
      )
    ));
    el.appendChild(h('p', { class: 'card__quote' }, text));

    if (opts.loading) {
      el.appendChild(h('div', { class: 'skeleton' },
        h('p', { class: 'muted' }, '正在分析句子成分…'),
        h('div', { class: 'sk-line' }), h('div', { class: 'sk-line sk-line--short' })));
      return el;
    }
    if (!result) {
      el.appendChild(h('div', { class: 'card__notice' },
        h('p', {}, '句子成分分析暂不可用。'),
        h('p', { class: 'muted' }, opts.error ? String(opts.error) : '分析引擎没有返回结果；查词功能不受影响。')));
      return el;
    }

    var conf = typeof result.confidence === 'number' ? result.confidence : 0;
    var confLabel = conf >= 0.75 ? '较高' : (conf >= 0.5 ? '中等' : '较低');
    el.appendChild(h('div', { class: 'card__meta-row' },
      h('span', { class: 'tag tag--soft' }, '自动推断 · 仅供参考'),
      h('span', { class: 'conf' }, '置信度 ' + Math.round(conf * 100) + '% · ' + confLabel),
      h('button', {
        class: 'btn btn--tiny' + (opts.rolesActive ? ' is-on' : ''), type: 'button',
        id: 'btn-role-toggle',
        onclick: function () { if (opts.onRoleToggle) opts.onRoleToggle(); }
      }, opts.rolesActive ? '取消原文着色' : '在原文着色')
    ));

    var sk = h('div', { class: 'skeleton' }, h('p', { class: 'eyebrow' }, '主干 · SKELETON'));
    if (result.summary) sk.appendChild(h('p', { class: 'skeleton__text' }, result.summary));
    var rows = Array.isArray(result.structure) ? result.structure.slice() : [];
    rows.sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
    if (rows.length) {
      var list = h('div', { class: 'struct-list' });
      rows.forEach(function (r) {
        list.appendChild(h('div', { class: 'struct-row' },
          h('span', { class: 'role role--' + r.role }, roleZh(r.role) || r.role),
          h('span', { class: 'struct-text' }, r.text)
        ));
      });
      sk.appendChild(list);
    } else {
      sk.appendChild(h('p', { class: 'muted' }, '没能可靠地找到主干；规则推断在长句或省略句上容易失败。'));
    }
    el.appendChild(sk);

    var notes = Array.isArray(result.notes) ? result.notes.slice() : [];
    notes.sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
    if (notes.length) {
      var nbox = h('div', { class: 'notes' }, h('p', { class: 'eyebrow' }, '语法点 · NOTES'));
      var ul = h('ul', { class: 'note-list' });
      notes.forEach(function (n) {
        var li = h('li', { class: 'note-item' },
          h('span', { class: 'note-chip note-chip--' + (n.kind || 'other') }, n.title || n.kind || '语法点'));
        if (n.detail) li.appendChild(h('span', { class: 'note-detail' }, n.detail));
        ul.appendChild(li);
      });
      nbox.appendChild(ul);
      el.appendChild(nbox);
    }

    var tokens = Array.isArray(result.tokens) ? result.tokens : [];
    if (tokens.length) {
      var det = h('details', { class: 'tokens' },
        h('summary', {}, '逐词词性 · ' + tokens.length + ' 词'));
      var cloud = h('div', { class: 'token-cloud' });
      tokens.forEach(function (t) {
        var role = t.role ? (roleZh(t.role) || t.role) : '';
        cloud.appendChild(h('span', { class: 'token token--' + (t.role || 'none') },
          h('b', {}, t.t), h('i', {}, posZh(t.pos) + (role ? ' · ' + role : ''))));
      });
      det.appendChild(cloud);
      el.appendChild(det);
    }

    var lg = h('div', { class: 'legend' }, h('p', { class: 'eyebrow' }, '着色图例'));
    var lgRow = h('div', { class: 'legend__row' });
    legend().forEach(function (l) {
      lgRow.appendChild(h('span', { class: 'legend__item' },
        h('i', { class: 'legend__swatch', style: { background: l.color || ('var(--role-' + l.id + ')') } }),
        l.zh));
    });
    lg.appendChild(lgRow);
    el.appendChild(lg);

    el.appendChild(h('p', { class: 'card__note' },
      '成分由规则推断，从句/省略/倒装等复杂结构可能标错；点击原文里的词仍可正常查词。'));
    return el;
  }

  /* ---------------- 空状态 ---------------- */
  function emptyInspector() {
    var el = h('div', { class: 'insp-empty', id: 'inspector-empty' });
    el.appendChild(h('p', { class: 'eyebrow' }, 'INSPECTOR · 检查器'));
    el.appendChild(h('h3', { class: 'insp-empty__title' }, '点一个词，或者一句话'));
    el.appendChild(h('p', { class: 'insp-empty__sub' }, '点词查本地词库，查过的词会自动进生词本；点句子空隙，可以看主语、谓语、从句和语法点。'));
    var tips = h('ul', { class: 'tips' });
    [
      ['点单词', '查音标、释义、词级、例句、发音'],
      ['Alt + 点击', '直接看任意句子的成分'],
      ['顶部「成分」', '开启后点句子任意位置看成分'],
      ['生词本', '查过的词自动留存，可复习']
    ].forEach(function (t) {
      tips.appendChild(h('li', {}, h('span', { class: 'kbd' }, t[0]), h('span', {}, t[1])));
    });
    el.appendChild(tips);

    var key = h('div', { class: 'level-key' }, h('p', { class: 'eyebrow' }, '词级下划线'));
    var row = h('div', { class: 'level-key__row' });
    [
      ['cet4', '四级'], ['cet6', '六级'], ['tem4', '专四'], ['tem8', '专八'], ['ielts', '雅思/托福']
    ].forEach(function (p) {
      row.appendChild(h('span', { class: 'level-key__item' },
        h('i', { class: 'level-key__swatch lv-' + p[0] }), p[1]));
    });
    key.appendChild(row);
    key.appendChild(h('p', { class: 'muted small' }, '按最低门槛词库着色（四级→六级→专四→专八），功能词不标；未收录词没有下划线。'));
    el.appendChild(key);

    el.appendChild(h('p', { class: 'insp-empty__note' }, '句子成分是规则推断，可能出错；以置信度与逐词词性为准。'));
    return el;
  }

  function setInspector(el) {
    var box = q('#inspector');
    if (!box) return;
    DR.dom.clear(box);
    if (el) box.appendChild(el);
    box.classList.add('is-open');
    box.scrollTop = 0;
  }
  function closeInspector() {
    var box = q('#inspector');
    if (!box) return;
    box.classList.remove('is-open');
    DR.dom.clear(box);
    box.appendChild(emptyInspector());
  }

  DR.card = {
    word: wordCard,
    sentence: sentenceCard,
    empty: emptyInspector,
    setInspector: setInspector,
    closeInspector: closeInspector,
    legend: legend,
    roleZh: roleZh,
    posZh: posZh,
    defLines: defLines,
    markFirst: markFirst
  };
})();
