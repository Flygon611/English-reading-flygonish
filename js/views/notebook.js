/* 生词本：查过的词、筛选、复习闪卡（间隔重复）。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var h = function () { return DR.dom.h.apply(null, arguments); };
  var q = function (s, r) { return DR.dom.q(s, r); };
  var icon = function (n, s) { return DR.ui.icon(n, s); };
  var toast = function (m, o) { return DR.ui.toast(m, o); };

  var els = {};
  var review = { queue: [], i: 0, revealed: false, results: { 1: 0, 2: 0, 3: 0 }, active: false };
  var inited = false;

  function init() {
    if (inited) return;
    inited = true;
    var view = q('#view-notebook');
    view.appendChild(build());
    els.search = q('#notebook-search');
    els.filter = q('#notebook-filter');
    els.bank = q('#notebook-bank');
    els.sort = q('#notebook-sort');
    els.list = q('#notebook-list');
    els.stats = q('#notebook-stats');
    els.dueBtn = q('#btn-review');
    els.dueBadge = q('#nb-due');
    els.mode = q('#review-mode');
    if (els.mode) {
      var st = DR.store.settings();
      var mode = st.reviewMode || 'mix';
      if (mode === 'audio' && !(DR.tts && DR.tts.hasVoice && DR.tts.hasVoice())) mode = 'mix';
      els.mode.value = mode;
      els.mode.addEventListener('change', function () {
        var s2 = DR.store.settings();
        s2.reviewMode = els.mode.value;
        DR.store.saveSettings(s2);
      });
    }

    els.dueBtn.addEventListener('click', function () { openReview('due'); });
    q('#btn-review-any').addEventListener('click', function () { openReview('any'); });
    els.search.addEventListener('input', DR.dom.debounce(renderList, 140));
    [els.filter, els.bank, els.sort].forEach(function (s) { s.addEventListener('change', renderList); });
    els.list.addEventListener('click', onListClick);
    document.addEventListener('keydown', onReviewKey);
  }

  function build() {
    var wrap = h('div', { class: 'nb' },
      h('header', { class: 'nb__head' },
        h('div', { class: 'nb__intro' },
          h('p', { class: 'eyebrow' }, 'NOTEBOOK · 生词本'),
          h('h1', { class: 'nb__title' }, '查过的词，都在这里。'),
          h('p', { class: 'nb__sub' }, '每查一个词就自动留一条记录（可在设置里关），连同它出现的那句话。之后按记忆曲线回来复习。')
        ),
        h('div', { class: 'nb__actions' },
          h('label', { class: 'nb__mode', title: '复习题型' },
            h('span', { class: 'nb__mode-label' }, '题型'),
            h('select', { id: 'review-mode', 'aria-label': '复习题型' },
              (function () {
                var list = [['mix', '混合题型'], ['flashcard', '闪卡'], ['meaning', '看词选义'], ['word', '看义选词'], ['cloze', '语境填空'], ['spell', '拼写']];
                if (DR.tts && DR.tts.hasVoice && DR.tts.hasVoice()) list.push(['audio', '听音选词']);
                return list.map(function (o) {
                  return h('option', { value: o[0], selected: (DR.store.settings().reviewMode || 'mix') === o[0] ? true : null }, o[1]);
                });
              })()
            )
          ),
          h('button', { class: 'btn btn--primary', id: 'btn-review', type: 'button' },
            icon('refresh', 16), '开始复习', h('span', { class: 'btn__count', id: 'nb-due', hidden: true }, '0')),
          h('button', { class: 'btn', id: 'btn-review-any', type: 'button' }, '巩固 10 词')
        )
      ),
      h('div', { class: 'nb__stats', id: 'notebook-stats' }),
      h('div', { class: 'nb__toolbar' },
        h('label', { class: 'search' },
          icon('search', 16),
          h('input', { id: 'notebook-search', type: 'search', placeholder: '搜索单词 / 中文释义…', autocomplete: 'off', 'aria-label': '搜索生词' })
        ),
        h('select', { id: 'notebook-filter', 'aria-label': '状态筛选' },
          h('option', { value: 'all' }, '全部状态'),
          h('option', { value: 'due' }, '待复习'),
          h('option', { value: 'new' }, '新词'),
          h('option', { value: 'learning' }, '学习中'),
          h('option', { value: 'known' }, '已掌握')
        ),
        h('select', { id: 'notebook-bank', 'aria-label': '词级筛选' },
          h('option', { value: 'all' }, '全部词级'),
          h('option', { value: 'cet4' }, '四级'),
          h('option', { value: 'cet6' }, '六级'),
          h('option', { value: 'tem4' }, '专四'),
          h('option', { value: 'tem8' }, '专八'),
          h('option', { value: 'ielts' }, '雅思'),
          h('option', { value: 'toefl' }, '托福')
        ),
        h('select', { id: 'notebook-sort', 'aria-label': '排序' },
          h('option', { value: 'recent' }, '最近查询'),
          h('option', { value: 'oldest' }, '最早查询'),
          h('option', { value: 'alpha' }, '按字母'),
          h('option', { value: 'count' }, '查询次数')
        )
      ),
      h('ul', { class: 'nb__list', id: 'notebook-list' })
    );
    return wrap;
  }

  function itemList() {
    var book = DR.store.notebook();
    return book.order.map(function (k) { return book.items[k]; }).filter(Boolean);
  }

  function statusZh(it) {
    var now = Date.now();
    if (it.status === 'known') return { k: 'known', zh: '已掌握' };
    if ((it.dueAt || 0) <= now) return { k: 'due', zh: '待复习' };
    if (it.status === 'new') return { k: 'new', zh: '新词' };
    return { k: 'learning', zh: '学习中' };
  }

  function show() {
    init();
    refresh();
    renderList();
  }

  function refresh() {
    var s = DR.store.bookStats();
    var dueBadge = q('#nb-due');
    if (dueBadge) { dueBadge.textContent = s.due; dueBadge.hidden = !s.due; }
    var stats = q('#notebook-stats');
    if (stats) {
      DR.dom.clear(stats);
      [
        ['收录', s.total, 'total'],
        ['待复习', s.due, 'due'],
        ['学习中', s.learning, 'learning'],
        ['已掌握', s.known, 'known']
      ].forEach(function (row) {
        stats.appendChild(h('div', { class: 'stat stat--' + row[2] },
          h('span', { class: 'stat__num' }, String(row[1])),
          h('span', { class: 'stat__label' }, row[0])));
      });
    }
    if (DR.reader && DR.reader.refreshMarks) DR.reader.refreshMarks();
  }

  function renderList() {
    if (!els.list) return;
    var items = itemList();
    var keyword = (els.search.value || '').trim().toLowerCase();
    var filter = els.filter.value;
    var bank = els.bank.value;
    var sort = els.sort.value;
    var now = Date.now();

    if (filter === 'due') items = items.filter(function (it) { return it.status !== 'known' && (it.dueAt || 0) <= now; });
    else if (filter !== 'all') items = items.filter(function (it) { return it.status === filter; });
    if (bank !== 'all') items = items.filter(function (it) { return (it.packs || []).indexOf(bank) >= 0; });
    if (keyword) {
      items = items.filter(function (it) {
        return (it.w + ' ' + (it.lemma || '') + ' ' + (it.zh || '')).toLowerCase().indexOf(keyword) >= 0;
      });
    }
    items.sort(function (a, b) {
      if (sort === 'alpha') return a.w.localeCompare(b.w);
      if (sort === 'count') return (b.count || 1) - (a.count || 1);
      if (sort === 'oldest') return (a.firstAt || 0) - (b.firstAt || 0);
      return (b.lastAt || 0) - (a.lastAt || 0);
    });

    DR.dom.clear(els.list);
    if (!items.length) {
      els.list.appendChild(h('li', { class: 'nb__empty' },
        h('p', { class: 'nb__empty-title' }, items.length === 0 && DR.store.bookStats().total === 0 ? '生词本还是空的。' : '没有符合条件的词。'),
        h('p', { class: 'muted' }, DR.store.bookStats().total === 0 ? '去阅读一篇文章，点几个词就会出现在这里。' : '换个筛选条件试试。'),
        DR.store.bookStats().total === 0 ? h('button', {
          class: 'btn btn--primary', type: 'button', onclick: function () { DR.router.go('read'); }
        }, '去阅读') : null
      ));
      return;
    }

    var frag = document.createDocumentFragment();
    items.slice(0, 300).forEach(function (it) { frag.appendChild(renderItem(it)); });
    els.list.appendChild(frag);
    if (items.length > 300) {
      els.list.appendChild(h('li', { class: 'nb__more' }, '只显示前 300 条（共 ' + items.length + ' 条）'));
    }
  }

  function renderItem(it) {
    var st = statusZh(it);
    var key = it.key;
    var row = h('button', {
      class: 'nb-row', type: 'button', 'aria-expanded': 'false', dataset: { key: key },
      onclick: function () { toggleDetail(key, row); }
    },
      h('span', { class: 'nb-row__main' },
        h('span', { class: 'nb-row__word' }, it.w, h('span', { class: 'nb-row__ipa' }, it.ipa ? '/' + it.ipa + '/' : '')),
        h('span', { class: 'nb-row__gloss' }, it.zh || '（无释义）')
      ),
      h('span', { class: 'nb-row__tags' }, (it.packs || []).map(function (p) {
        var b = DR.ui.packBadge(p); return b || null;
      })),
      h('span', { class: 'nb-row__meta' },
        h('span', { class: 'nb-row__count' }, '查过 ' + (it.count || 1) + ' 次'),
        h('span', { class: 'nb-row__time' }, DR.dom.relTime(it.lastAt || it.firstAt || Date.now())),
        h('span', { class: 'nb-status nb-status--' + st.k }, st.zh)
      ),
      h('span', { class: 'nb-row__chev' }, icon('chevron', 16))
    );

    var detail = h('div', { class: 'nb-detail', hidden: true });
    detail.appendChild(h('div', { class: 'nb-detail__head' },
      h('div', { class: 'nb-detail__def' },
        it.lemma && it.lemma !== String(it.w).toLowerCase() ? h('p', { class: 'nb-detail__lemma' }, '原形：' + it.lemma) : null,
        DR.card.defLines(it.zh).slice(0, 4).map(function (d) { return h('p', { class: 'nb-detail__zh' }, d); })),
      h('div', { class: 'nb-detail__acts' },
        h('button', { class: 'btn btn--tiny', type: 'button', dataset: { act: 'speak' }, onclick: function () { speak(it.w); } }, icon('speaker', 14), '朗读'),
        h('button', {
          class: 'btn btn--tiny', type: 'button', dataset: { act: 'toggle-known' },
          onclick: function () {
            DR.store.setStatus(key, it.status === 'known' ? 'learning' : 'known');
            toast(it.status === 'known' ? '已取消「已掌握」' : '标记为已掌握');
            refresh();
            renderList();
          }
        }, it.status === 'known' ? '取消已掌握' : '标记已掌握'),
        h('button', {
          class: 'btn btn--tiny btn--danger-ghost', type: 'button', dataset: { act: 'remove' },
          onclick: function () {
            DR.store.removeItem(key);
            toast('已移出生词本');
            refresh();
            renderList();
          }
        }, '移出')
      )
    ));
    if (it.forms && it.forms.length) {
      detail.appendChild(h('p', { class: 'nb-detail__forms' }, '词形：' + it.forms.slice(0, 8).join(' · ')));
    }
    if (it.ex) {
      detail.appendChild(h('blockquote', { class: 'example example--small' },
        h('p', {}, it.ex), it.exZh ? h('p', { class: 'example__zh' }, it.exZh) : null));
    }
    var contexts = (it.contexts || []).slice(0, 3);
    if (contexts.length) {
      var ctxBox = h('div', { class: 'nb-contexts' }, h('p', { class: 'eyebrow' }, '原文语境'));
      contexts.forEach(function (c) {
        ctxBox.appendChild(h('div', { class: 'nb-context' },
          h('p', { class: 'nb-context__text' }, DR.card.markFirst(c.text, [it.w, it.lemma])),
          h('p', { class: 'nb-context__meta' },
            h('span', {}, c.title || '文章'),
            c.articleId && DR.store.getArticle(c.articleId) ? h('button', {
              class: 'link', type: 'button',
              onclick: function () {
                DR.router.go('read');
                DR.reader.openArticle(c.articleId);
              }
            }, '回到原文') : null)
        ));
      });
      detail.appendChild(ctxBox);
    }
    if (!contexts.length && !it.ex) {
      detail.appendChild(h('p', { class: 'muted small' }, '这个词语境记录为空（可能是在词库页查询的）。'));
    }

    return h('li', { class: 'nb-item', dataset: { key: key }, 'data-status': st.k }, row, detail);
  }

  function toggleDetail(key, row) {
    var li = row.closest('.nb-item');
    var detail = li.querySelector('.nb-detail');
    var open = !detail.hidden;
    detail.hidden = open;
    row.setAttribute('aria-expanded', String(!open));
    li.classList.toggle('is-open', !open);
  }

  function speak(text) {
    if (!DR.tts.hasVoice()) { toast('系统里没有可用的英语语音', { kind: 'warn' }); return; }
    DR.tts.speak(text, { word: true });
  }

  function refreshIfVisible() {
    if (DR.router.current() === 'notebook') { refresh(); renderList(); }
  }

  /* ---------------- 复习 ---------------- */
  var MODE_LABEL = {
    mix: '混合题型', flashcard: '闪卡', meaning: '看词选义',
    word: '看义选词', cloze: '语境填空', spell: '拼写', audio: '听音选词'
  };
  var TYPE_LABEL = {
    flash: '闪卡', meaning: '看词选义', word: '看义选词',
    cloze: '语境填空', spell: '拼写', audio: '听音选词'
  };

  function currentMode() {
    var mode = els.mode && els.mode.value;
    if (!mode) mode = (DR.store.settings().reviewMode || 'mix');
    if (mode === 'audio' && !(DR.tts && DR.tts.hasVoice && DR.tts.hasVoice())) mode = 'mix';
    return mode;
  }

  function openReview(kind) {
    init();
    var mode = currentMode();
    var queue = kind === 'any' ? DR.store.anyList(10) : DR.store.dueList(20);
    var label = '复习';
    if (!queue.length) {
      var all = DR.store.bookStats().total;
      if (!all) { toast('生词本还是空的，先查几个词吧', { kind: 'warn' }); return; }
      queue = DR.store.anyList(10);
      label = '巩固';
    } else if (kind === 'due' && queue.length < 10) {
      var extra = DR.store.anyList(10 - queue.length).filter(function (x) {
        return !queue.some(function (y) { return y.key === x.key; });
      });
      queue = queue.concat(extra);
    }
    var questions = null;
    if (DR.quiz && mode !== 'flashcard') questions = DR.quiz.build(queue, mode);
    if (!questions || !questions.length) {
      questions = queue.map(function (it) { return DR.quiz ? DR.quiz.flashOf(it) : { type: 'flash', item: it }; });
      mode = 'flashcard';
    }
    review = {
      queue: queue, i: 0, results: { 1: 0, 2: 0, 3: 0 }, active: true,
      label: label, mode: mode, questions: questions, answered: false, revealed: false
    };
    renderReview();
    DR.ui.openModal('review');
  }

  function typeZh(t) { return TYPE_LABEL[t] || '复习'; }
  function modeZh(m) { return MODE_LABEL[m] || '复习'; }

  function renderReview() {
    var body = q('#review-body');
    if (!body) return;
    DR.dom.clear(body);
    if (review.i >= review.questions.length) { renderReviewDone(body); return; }
    var qq = review.questions[review.i];
    var total = review.questions.length;
    var bar = h('div', { class: 'review__bar' },
      h('span', { class: 'review__counter' }, (review.i + 1) + ' / ' + total),
      h('span', { class: 'review__label' }, (review.label === '巩固' ? '巩固' : '复习') + ' · ' + typeZh(qq.type))
    );
    var progress = h('div', { class: 'review__progress' },
      h('i', { style: { width: Math.round(review.i / total * 100) + '%' } }));
    body.appendChild(bar);
    body.appendChild(progress);
    if (qq.type === 'flash') {
      body.appendChild(renderFlashCard(qq.item));
    } else {
      body.appendChild(renderQuizCard(qq));
    }
    review.answered = false;
    review.revealed = false;
    review.active = true;
  }

  /* ---- 闪卡 ---- */
  function renderFlashCard(it) {
    var answer = h('div', { class: 'review__answer', hidden: true },
      h('div', { class: 'defs' }, DR.card.defLines(it.zh).slice(0, 5).map(function (d) {
        return h('p', {}, d);
      })),
      it.forms && it.forms.length ? h('p', { class: 'kv' }, h('span', { class: 'kv__k' }, '词形'), h('span', { class: 'kv__v' }, it.forms.slice(0, 8).join(' · '))) : null,
      it.ex ? h('blockquote', { class: 'example example--small' }, h('p', {}, it.ex), it.exZh ? h('p', { class: 'example__zh' }, it.exZh) : null) : null
    );
    var fullCtx = (it.contexts && it.contexts[0]) ? it.contexts[0].text : '';
    var ctxLine = fullCtx ? blankWord(fullCtx, it) : '';
    return h('div', { class: 'review__card', id: 'review-card' },
      h('p', { class: 'eyebrow' }, 'WORD · 你查过这个词'),
      h('h2', { class: 'review__word' }, it.w),
      it.ipa ? h('p', { class: 'ipa' }, '/' + it.ipa + '/') : null,
      it.lemma && it.lemma !== String(it.w).toLowerCase() ? h('p', { class: 'review__lemma' }, '原形 ' + it.lemma) : null,
      h('div', { class: 'tags' }, (it.packs || []).map(function (p) { return DR.ui.packBadge(p); })),
      ctxLine ? h('p', { class: 'review__ctx' }, ctxLine) : null,
      h('button', { class: 'btn btn--primary', type: 'button', id: 'review-reveal', onclick: reveal }, '显示释义 · 空格'),
      answer,
      h('div', { class: 'review__rates', hidden: true },
        h('button', { class: 'btn rate rate--again', type: 'button', id: 'btn-rate-1', onclick: function () { rate(1); } }, h('b', {}, '1'), '不认识'),
        h('button', { class: 'btn rate rate--hard', type: 'button', id: 'btn-rate-2', onclick: function () { rate(2); } }, h('b', {}, '2'), '模糊'),
        h('button', { class: 'btn rate rate--good', type: 'button', id: 'btn-rate-3', onclick: function () { rate(3); } }, h('b', {}, '3'), '认识')
      ),
      h('p', { class: 'review__hint' }, '先在心里说出释义，再翻面；按 1 / 2 / 3 评分。')
    );
  }

  /* ---- 选择题 / 拼写 ---- */
  function renderQuizCard(qq) {
    var it = qq.item;
    var card = h('div', { class: 'review__card review__card--quiz', id: 'review-card' });
    card.appendChild(h('p', { class: 'eyebrow' }, 'REVIEW · ' + typeZh(qq.type)));

    if (qq.type === 'meaning') {
      card.appendChild(h('h2', { class: 'review__word' }, qq.prompt));
      if (qq.ipa) card.appendChild(h('p', { class: 'ipa' }, '/' + qq.ipa + '/'));
      card.appendChild(h('p', { class: 'review__hint' }, '选出它的中文释义'));
    } else if (qq.type === 'word') {
      card.appendChild(h('p', { class: 'review__prompt-zh' }, qq.prompt));
      card.appendChild(h('p', { class: 'review__hint' }, '选出对应的英文单词'));
    } else if (qq.type === 'cloze') {
      card.appendChild(h('p', { class: 'review__sentence' }, qq.prompt));
      card.appendChild(h('p', { class: 'review__hint' }, '根据语境选出最合适的词'));
    } else if (qq.type === 'audio') {
      card.appendChild(h('button', {
        class: 'btn btn--primary review__play', type: 'button', id: 'review-audio-play',
        onclick: function () { if (DR.tts) DR.tts.speak(it.w, { word: true }); }
      }, DR.ui.icon('speaker', 16), '播放发音'));
      card.appendChild(h('p', { class: 'review__hint' }, '听发音，选出你听到的单词'));
    } else if (qq.type === 'spell') {
      card.appendChild(h('p', { class: 'review__prompt-zh' }, qq.prompt));
      card.appendChild(h('p', { class: 'review__hint' }, qq.hint));
      card.appendChild(h('div', { class: 'review__spell' },
        h('input', {
          id: 'review-spell-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
          placeholder: '输入英文单词…',
          onkeydown: function (e) {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitSpell(); }
          }
        }),
        h('button', { class: 'btn btn--primary', type: 'button', id: 'review-spell-submit', onclick: submitSpell }, '检查')
      ));
    }

    if (qq.options) {
      var opts = h('div', { class: 'review__opts' });
      qq.options.forEach(function (o, i) {
        opts.appendChild(h('button', {
          class: 'review__opt', type: 'button', id: 'review-opt-' + i,
          onclick: function () { answerChoice(i); }
        }, h('span', { class: 'review__opt-key' }, String(i + 1)), h('span', { class: 'review__opt-text' }, o.text)));
      });
      card.appendChild(opts);
    }

    card.appendChild(h('div', { class: 'review__feedback', id: 'review-feedback', hidden: true }));
    card.appendChild(h('button', {
      class: 'btn btn--primary', type: 'button', id: 'review-next', hidden: true,
      onclick: nextQuestion
    }, '下一题 · Enter'));
    card.appendChild(h('p', { class: 'review__hint', id: 'review-quiz-hint' }, '按数字键选择；答完按 Enter 进入下一题。'));
    return card;
  }

  function recordRating(rating) {
    var qq = review.questions[review.i];
    if (!qq) return;
    DR.store.rate(qq.item.key, rating);
    review.results[rating] += 1;
    refresh();
  }

  function answerChoice(idx) {
    var qq = review.questions[review.i];
    if (!qq || review.answered || !qq.options) return;
    var chosen = qq.options[idx];
    if (!chosen) return;
    review.answered = true;
    var correct = !!chosen.correct;
    var opts = DR.dom.qa('#review-card .review__opt');
    opts.forEach(function (btn, i) {
      btn.disabled = true;
      if (qq.options[i] && qq.options[i].correct) btn.classList.add('is-correct');
      if (i === idx && !correct) btn.classList.add('is-wrong');
    });
    recordRating(correct ? 3 : 1);
    showFeedback(qq, correct, correct ? 3 : 1, chosen.text);
  }

  function submitSpell() {
    var qq = review.questions[review.i];
    if (!qq || review.answered || qq.type !== 'spell') return;
    var input = q('#review-spell-input');
    if (!input) return;
    var val = String(input.value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!val) { toast('先拼出这个单词', { kind: 'warn' }); input.focus(); return; }
    var accepted = (qq.accept || []).indexOf(val) >= 0;
    var near = false;
    if (!accepted) {
      var best = 999;
      (qq.accept || []).forEach(function (a) {
        var d = DR.quiz.editDistance(val, a, 2);
        if (d < best) best = d;
      });
      near = best <= 1;
    }
    review.answered = true;
    input.disabled = true;
    var rating = accepted ? 3 : (near ? 2 : 1);
    recordRating(rating);
    showFeedback(qq, accepted, rating, val, { near: near });
  }

  function showFeedback(qq, correct, rating, chosenText, opts) {
    opts = opts || {};
    var box = q('#review-feedback');
    if (!box) return;
    var it = qq.item;
    box.hidden = false;
    box.className = 'review__feedback ' + (correct ? 'is-correct' : 'is-wrong');
    DR.dom.clear(box);
    box.appendChild(h('p', { class: 'review__fb-title' },
      correct ? '✓ 答对了' : (opts.near ? '△ 差一点' : '× 再记一下')));
    if (qq.type === 'spell') {
      if (correct) {
        box.appendChild(h('p', { class: 'review__fb-line' }, '拼写正确。'));
      } else {
        box.appendChild(h('p', { class: 'review__fb-line' },
          '你写的是 ', h('b', {}, chosenText || '（空）'),
          '，正确拼写是 ', h('b', { class: 'review__fb-answer' }, qq.answerText)));
      }
    } else {
      box.appendChild(h('p', { class: 'review__fb-line' },
        '正确答案：', h('b', { class: 'review__fb-answer' }, qq.answerText)));
    }
    box.appendChild(h('p', { class: 'review__fb-word' }, it.w + (it.ipa ? '  /' + it.ipa + '/' : '')));
    var defs = h('div', { class: 'defs' });
    DR.card.defLines(it.zh).slice(0, 3).forEach(function (d) { defs.appendChild(h('p', {}, d)); });
    box.appendChild(defs);
    if (qq.type === 'cloze' && qq.fullContext) {
      box.appendChild(h('p', { class: 'review__fb-ctx' }, qq.fullContext));
    }
    if (rating === 2) box.appendChild(h('p', { class: 'review__fb-note' }, '拼写只差一点，按「模糊」记录。'));
    var next = q('#review-next');
    if (next) {
      next.hidden = false;
      next.textContent = review.i + 1 >= review.questions.length ? '看结果 · Enter' : '下一题 · Enter';
      setTimeout(function () { try { next.focus(); } catch (e) {} }, 40);
    }
    var hint = q('#review-quiz-hint');
    if (hint) hint.textContent = correct ? '按 Enter 进入下一题。' : '记住正确答案，按 Enter 继续。';
  }

  function nextQuestion() {
    if (!review.answered) return;
    review.i += 1;
    if (review.i >= review.questions.length) renderReviewDone(q('#review-body'));
    else renderReview();
  }

  function blankWord(text, it) {
    var forms = [it.w, it.lemma].concat(it.forms || []).filter(Boolean);
    var uniq = [];
    forms.forEach(function (f) { if (uniq.indexOf(f) < 0) uniq.push(f); });
    var re = new RegExp('\\b(?:' + uniq.map(function (f) {
      return String(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|') + ')\\b', 'i');
    if (!re.test(text)) return '"' + text + '"';
    return text.replace(re, '____');
  }

  function reveal() {
    if (review.revealed) return;
    review.revealed = true;
    var card = q('#review-card');
    if (!card) return;
    var ans = card.querySelector('.review__answer');
    var rates = card.querySelector('.review__rates');
    var rev = q('#review-reveal');
    if (ans) ans.hidden = false;
    if (rates) rates.hidden = false;
    if (rev) rev.hidden = true;
    var it = review.questions[review.i] && review.questions[review.i].item;
    if (it && it.contexts && it.contexts[0]) {
      var ctx = card.querySelector('.review__ctx');
      if (ctx) ctx.textContent = it.contexts[0].text;
    }
  }

  function rate(r) {
    if (!review.revealed) { reveal(); return; }
    recordRating(r);
    review.i += 1;
    if (review.i >= review.questions.length) renderReviewDone(q('#review-body'));
    else renderReview();
  }

  function renderReviewDone(body) {
    if (!body) return;
    DR.dom.clear(body);
    var res = review.results;
    review.active = false;
    var due = DR.store.bookStats().due;
    body.appendChild(h('div', { class: 'review__done', id: 'review-done' },
      h('p', { class: 'eyebrow' }, 'REVIEW COMPLETE'),
      h('h2', { class: 'review__done-title' }, '这一轮结束了。'),
      h('div', { class: 'review__summary' },
        h('div', { class: 'rs rs--good' }, h('b', {}, res[3]), h('span', {}, '认识')),
        h('div', { class: 'rs rs--hard' }, h('b', {}, res[2]), h('span', {}, '模糊')),
        h('div', { class: 'rs rs--again' }, h('b', {}, res[1]), h('span', {}, '不认识'))
      ),
      h('p', { class: 'review__done-note' }, due ? '还有 ' + due + ' 个词到期待复习。' : '暂时没有到期的词了，明天再回来看看。'),
      h('div', { class: 'review__done-actions' },
        h('button', { class: 'btn btn--primary', type: 'button', onclick: function () { openReview('due'); } }, '再复习一轮'),
        h('button', { class: 'btn', type: 'button', onclick: function () { DR.ui.closeModal(); refresh(); renderList(); } }, '完成')
      )
    ));
    refresh();
    renderList();
  }

  function onReviewKey(e) {
    if (DR.ui.currentModal() !== 'review' || !review.active) return;
    var qq = review.questions[review.i];
    if (!qq) return;
    var active = document.activeElement;
    var tag = active && active.tagName;
    if (qq.type === 'flash') {
      if (e.key === ' ' || e.key === 'Enter') {
        if (tag === 'BUTTON' || tag === 'INPUT') return;
        e.preventDefault();
        if (!review.revealed) reveal();
        return;
      }
      if (review.revealed && (e.key === '1' || e.key === '2' || e.key === '3')) {
        e.preventDefault();
        rate(Number(e.key));
      }
      return;
    }
    if (tag === 'INPUT') {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (review.answered) nextQuestion(); else submitSpell();
      }
      return;
    }
    if (!review.answered) {
      if (/^[1-4]$/.test(e.key) && qq.options) { e.preventDefault(); answerChoice(Number(e.key) - 1); return; }
      if (e.key === 'Enter' && qq.type === 'spell') { e.preventDefault(); submitSpell(); return; }
      if ((e.key === ' ' || e.key === 'Enter') && qq.options) { e.preventDefault(); return; }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      nextQuestion();
    }
  }

  function onListClick(e) {
    // 行内按钮已在各自 onclick 处理，这里只兜底
  }

  DR.notebook = {
    init: init,
    show: show,
    refresh: refresh,
    renderList: renderList,
    refreshIfVisible: refreshIfVisible,
    openReview: openReview,
    currentReview: function () { return review; },
    reviewState: review
  };
})();
