/* 词库页：全库搜索 + 词条详情（复用单词卡）。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var h = function () { return DR.dom.h.apply(null, arguments); };
  var q = function (s, r) { return DR.dom.q(s, r); };
  var icon = function (n, s) { return DR.ui.icon(n, s); };
  var toast = function (m, o) { return DR.ui.toast(m, o); };

  var els = {};
  var inited = false;
  var lastQuery = '';
  var activeWord = '';

  function init() {
    if (inited) return;
    inited = true;
    var view = q('#view-dict');
    view.appendChild(h('div', { class: 'dict' },
      h('header', { class: 'dict__head' },
        h('p', { class: 'eyebrow' }, 'DICTIONARY · 词库'),
        h('h1', { class: 'dict__title' }, '查一个词。'),
        h('p', { class: 'dict__sub' }, '本地加载：六套考试词库 + ECDICT 兜底词典。支持前缀和包含匹配，不联网。'),
        h('label', { class: 'dict__search' },
          icon('search', 18),
          h('input', {
            id: 'dict-search', type: 'search', placeholder: '输入英文单词，例如 ubiquitous / deliberating',
            autocomplete: 'off', 'aria-label': '查词'
          }),
          h('kbd', {}, 'Ctrl K')
        ),
        h('p', { class: 'dict__stats', id: 'dict-stats' }, '正在准备词库…')
      ),
      h('div', { class: 'dict__body' },
        h('ul', { class: 'dict__results', id: 'dict-result' }),
        h('aside', { class: 'dict__detail', id: 'dict-detail' })
      )
    ));
    els.search = q('#dict-search');
    els.results = q('#dict-result');
    els.detail = q('#dict-detail');
    els.stats = q('#dict-stats');
    els.search.addEventListener('input', DR.dom.debounce(function () { search(els.search.value); }, 180));
    els.search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); search(els.search.value); }
      if (e.key === 'Escape') { els.search.value = ''; search(''); }
    });
    closeDetail();
  }

  function show() {
    init();
    updateStats();
    if (!lastQuery) renderEmptyResults();
    if (!DR.dict.hasFull()) DR.dict.ensureFull().then(updateStats);
    setTimeout(function () { if (els.search && document.activeElement !== els.search && !lastQuery) els.search.focus(); }, 60);
  }

  function updateStats() {
    if (!els.stats) return;
    var s = DR.dict.stats();
    DR.dom.clear(els.stats);
    els.stats.appendChild(h('span', {}, '考试词库 ' + s.exam.toLocaleString('en-US') + ' 条'));
    els.stats.appendChild(h('span', { class: 'sep' }, '·'));
    els.stats.appendChild(h('span', {}, s.fullLoaded ? '兜底词典 ' + s.full.toLocaleString('en-US') + ' 条' : '兜底词典加载中…'));
    els.stats.appendChild(h('span', { class: 'sep' }, '·'));
    els.stats.appendChild(h('span', { class: 'muted' }, '全部在本机，离线可用'));
    var counts = null;
    if (window.DR_EXAM && Array.isArray(window.DR_EXAM.words)) {
      counts = {};
      window.DR_EXAM.words.forEach(function (row) {
        var m = row[5] || 0;
        DR.dict.PACKS.forEach(function (p) { if (m & p.bit) counts[p.id] = (counts[p.id] || 0) + 1; });
      });
    }
    if (counts) {
      var row2 = h('span', { class: 'dict__banks' });
      ['cet4', 'cet6', 'tem4', 'tem8', 'ielts', 'toefl'].forEach(function (id) {
        row2.appendChild(h('span', {}, (DR.dict.PACK_BY_ID[id] ? DR.dict.PACK_BY_ID[id].zh : id) + ' ' + (counts[id] || 0).toLocaleString('en-US')));
      });
      els.stats.appendChild(row2);
    }
    if (DR.dict.hasFull() && els.search && !lastQuery) renderEmptyResults();
  }

  function renderEmptyResults() {
    if (!els.results) return;
    DR.dom.clear(els.results);
    var book = DR.store.notebook();
    var items = book.order.map(function (k) { return book.items[k]; }).filter(Boolean).slice(0, 18);
    if (!items.length) {
      els.results.appendChild(h('li', { class: 'dict__hint' },
        h('p', {}, '输入一个词开始查；查过的词会自动进生词本。'),
        h('p', { class: 'muted' }, '提示：词库页只查词，不自动记录语境；阅读页查词会带上原句。')));
      return;
    }
    els.results.appendChild(h('li', { class: 'dict__hint' },
      h('p', { class: 'eyebrow' }, '最近查过'),
      h('p', { class: 'muted' }, '点一下可以重新打开词条。')));
    items.forEach(function (it) {
      els.results.appendChild(resultRow({
        w: it.w, ipa: it.ipa, zh: it.zh, packs: it.packs, rank: 0, source: 'exam', forms: it.forms || []
      }, true));
    });
  }

  function search(qtext) {
    var s = String(qtext || '').trim();
    lastQuery = s;
    DR.dom.clear(els.results);
    if (!s) { renderEmptyResults(); return; }
    if (!DR.dict.hasFull()) {
      els.results.appendChild(h('li', { class: 'dict__hint' }, h('p', {}, '正在加载兜底词典，请稍等…')));
      DR.dict.ensureFull().then(function () { updateStats(); search(s); });
      return;
    }
    var rows = DR.dict.search(s, 40);
    if (!rows.length) {
      var r = DR.dict.resolve(s);
      if (r) rows = [r.entry];
    }
    if (!rows.length) {
      els.results.appendChild(h('li', { class: 'dict__hint' },
        h('p', {}, '本地词库没有找到「' + s + '」。'),
        h('p', { class: 'muted' }, '可以试试词形还原后的原形，或检查拼写。'),
        h('button', { class: 'btn btn--tiny', type: 'button', onclick: function () { openDetail(null, s); } }, '仍然为它建一条记录')));
      return;
    }
    rows.forEach(function (entry) {
      els.results.appendChild(resultRow(entry, false));
    });
    if (rows.length === 1) openDetail(rows[0], rows[0].w);
  }

  function resultRow(entry, compact) {
    var li = h('li', { class: 'dict__row' });
    var btn = h('button', {
      class: 'dict__row-btn', type: 'button', dataset: { w: entry.w },
      onclick: function () { openDetail(entry, entry.w); }
    },
      h('span', { class: 'dict__word' }, entry.w,
        entry.ipa ? h('span', { class: 'dict__ipa' }, '/' + entry.ipa + '/') : null),
      h('span', { class: 'dict__gloss' }, entry.zh || '（无中文释义）'),
      h('span', { class: 'tags' }, (entry.packs || []).map(function (p) { return DR.ui.packBadge(p); }))
    );
    li.appendChild(btn);
    return li;
  }

  function openDetail(entry, raw) {
    if (!els.detail) return;
    activeWord = raw;
    DR.dom.qa('.dict__row-btn.is-active', els.results).forEach(function (b) { b.classList.remove('is-active'); });
    var btn = q('.dict__row-btn[data-w="' + (window.CSS && CSS.escape ? CSS.escape(entry ? entry.w : raw) : raw) + '"]', els.results);
    if (btn) btn.classList.add('is-active');

    var settings = DR.store.settings();
    if (entry && settings.autoAdd) {
      DR.store.addLookup(entry, null);
      if (DR.reader) DR.reader.refreshBadges();
    }

    var card = DR.card.word(entry, {
      raw: raw,
      context: null,
      onClose: function () { closeDetail(); },
      onChanged: function () {
        if (DR.reader) DR.reader.refreshBadges();
        if (DR.notebook && DR.notebook.refreshIfVisible) DR.notebook.refreshIfVisible();
      },
      onRerender: function (next) {
        DR.dom.clear(els.detail);
        els.detail.appendChild(next);
      },
      onLemma: function (lemma) {
        var r = DR.dict.resolve(lemma);
        openDetail(r ? r.entry : null, lemma);
      }
    });
    DR.dom.clear(els.detail);
    els.detail.appendChild(card);
    els.detail.classList.add('is-open');
  }

  function closeDetail() {
    if (!els.detail) return;
    DR.dom.clear(els.detail);
    els.detail.classList.remove('is-open');
    activeWord = '';
    els.detail.appendChild(h('div', { class: 'dict__detail-empty' },
      h('p', { class: 'eyebrow' }, 'DETAIL'),
      h('p', {}, '选一个词，看它的音标、释义、词级和词形。'),
      h('p', { class: 'muted small' }, '这里的查询也会自动收入生词本（可在设置里关闭）。')));
  }

  function focusSearch() {
    if (els.search) { els.search.focus(); els.search.select(); }
  }

  DR.dictionary = { init: init, show: show, focusSearch: focusSearch, search: search, closeDetail: closeDetail };
})();
