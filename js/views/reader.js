/* 阅读视图：文章库、正文渲染、点词查词、点句分析、进度与朗读。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var h = function () { return DR.dom.h.apply(null, arguments); };
  var q = function (s, r) { return DR.dom.q(s, r); };
  var icon = function (n, s) { return DR.ui.icon(n, s); };
  var toast = function (m, o) { return DR.ui.toast(m, o); };

  var SAMPLE = {
    id: 'sample-quiet-room-v1',
    title: 'The Quiet Room',
    text: [
      'A reading room is a strange kind of place. Nobody owns it, yet everyone behaves as if it were a borrowed apartment. Coats go on the backs of chairs, bags are placed carefully on the floor, and the only sounds are the turning of pages, an occasional cough, and the soft scratch of a pencil.',
      'When I first began to read seriously, I treated every book as a test. I underlined difficult words, copied their definitions into a notebook, and promised myself that I would review them later. Usually I did not. The notebook filled up; the words drifted away.',
      'Eventually I discovered that a word learned in the middle of a sentence stays with you longer than a word learned from a list. Context gives the word a home. It tells you which meaning is being used, what tone the writer intends, and why this word rather than a simpler one. A definition you have to look up three times is not yet yours; a word you have met in three different stories is beginning to be.',
      'So I stopped treating reading as an examination. I began to read slowly, to notice the sentences that resisted me, and to keep a record of what I had noticed. Some of those records are still here. If you are reading this, the room is yours now. Put the coat on the back of the chair, pick a paragraph, and begin.'
    ].join('\n\n')
  };

  var state = {
    article: null,
    paragraphs: [],
    sentences: [],
    analyses: new Map(),
    activeWord: '',
    activeSi: -1,
    rolesOn: false,
    rolesSi: -1,
    sentenceMode: false,
    rendered: false,
    welcome: false,
    chapters: null,      // 电子书章节 [{title, book, text}]
    ci: 0,               // 当前章下标
    pendingBook: null,   // 解析完、还没保存进书库的书
    bookScroll: {}       // 章 → 上次滚动位置
  };
  var els = {};
  var scrollSave = null;

  function init() {
    els.body = q('#article-body');
    els.head = q('#article-head');
    els.scroll = q('#article-scroll');
    els.libraryList = q('#library-list');
    els.libraryFoot = q('#library-foot');
    els.inspector = q('#inspector');
    els.library = q('#library');
    els.search = q('#library-search');

    q('#btn-new-article').addEventListener('click', openPaste);
    q('#library-close').addEventListener('click', closeLibrary);
    q('#library-toggle').addEventListener('click', toggleLibrary);
    q('#library-search').addEventListener('input', DR.dom.debounce(renderLibrary, 120));
    els.body.addEventListener('click', onBodyClick);
    els.scroll.addEventListener('scroll', DR.dom.debounce(onScroll, 260));
    els.body.addEventListener('mouseup', function () {
      var sel = String(window.getSelection ? window.getSelection() : '');
      if (sel && sel.length > 40) return; // 用户在选择文本，不要抢
    });
    document.addEventListener('keydown', onKey);
    els.inspector.addEventListener('click', function (e) { e.__drInsideInspector = true; });
    document.addEventListener('click', function (e) {
      if (window.innerWidth > 860) return;
      if (!document.body.classList.contains('sheet-open')) return;
      if (e.__drInsideInspector) return;
      if (e.target.closest('#inspector') || e.target.closest('.w') || e.target.closest('.sent')) return;
      clearSelection();
    });
    bindPasteModal();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (DR.ui.currentModal()) { DR.ui.closeModal(); return; }
      if (state.activeWord || state.activeSi >= 0) clearSelection();
      return;
    }
    if (!state.chapters || DR.ui.currentModal()) return;
    var inArticle = e.target === document.body || (e.target.closest && e.target.closest('#article-scroll'));
    if (!inArticle) return;
    if (e.key === 'ArrowLeft') { gotoChapter(state.ci - 1); }
    else if (e.key === 'ArrowRight') { gotoChapter(state.ci + 1); }
  }

  /* ---------------- 文章库 ---------------- */
  function renderLibrary() {
    if (!els.libraryList) return;
    var list = DR.store.articles();
    var filter = (els.search && els.search.value || '').trim().toLowerCase();
    DR.dom.clear(els.libraryList);
    if (!list.length) {
      els.libraryList.appendChild(h('li', { class: 'library__empty' },
        h('p', {}, '还没有文章。'),
        h('p', { class: 'muted small' }, '点右上角的 + 粘贴一篇。')));
    } else {
      list.filter(function (a) {
        return !filter || String(a.title || '').toLowerCase().indexOf(filter) >= 0;
      }).forEach(function (a, i) {
        var active = state.article && a.id === state.article.id;
        var isBook = a.kind === 'book';
        var s = DR.text.stats(a.text || '');
        var metaText = isBook
          ? ((a.author ? a.author + ' · ' : '') + (a.chapterCount || 0) + ' 章 · ' +
             (a.wordCount || 0).toLocaleString('en-US') + ' 词')
          : (s.wordCount + ' 词 · ' + DR.dom.fmtDate(a.updatedAt || a.createdAt));
        var li = h('li', { class: 'library__item' + (active ? ' is-active' : '') });
        var btn = h('button', {
          class: 'library__btn', type: 'button', dataset: { id: a.id },
          onclick: function () { openArticle(a.id); }
        },
          h('span', { class: 'library__idx' }, String(i + 1).padStart(2, '0')),
          h('span', { class: 'library__body' },
            h('span', { class: 'library__name' }, a.title || '未命名'),
            h('span', { class: 'library__meta' }, metaText),
            h('span', { class: 'library__bar' },
              h('i', { style: { width: Math.round((a.progress || 0) * 100) + '%' } }))
          )
        );
        li.appendChild(btn);
        els.libraryList.appendChild(li);
      });
    }
    renderLibraryFoot();
  }

  function renderLibraryFoot() {
    if (!els.libraryFoot) return;
    var today = DR.store.todayStats();
    var bs = DR.store.bookStats();
    DR.dom.clear(els.libraryFoot);
    els.libraryFoot.appendChild(h('div', { class: 'library__stats' },
      h('span', { title: '今天查过的词' }, '查词 ' + today.looked),
      h('span', { title: '今天复习次数' }, '复习 ' + today.reviewed),
      h('span', { title: '生词本总数' }, '生词 ' + bs.total)
    ));
    els.libraryFoot.appendChild(h('p', { class: 'library__note' }, '内容只保存在本机浏览器 · 查词不用联网'));
  }

  function toggleLibrary() {
    if (DR.router && DR.router.current() !== 'read') DR.router.go('read');
    var open = !els.library.classList.contains('is-open');
    els.library.classList.toggle('is-open', open);
    document.body.classList.toggle('library-open', open);
    if (open && window.innerWidth <= 860) clearSelection();
  }
  function closeLibrary() {
    els.library.classList.remove('is-open');
    document.body.classList.remove('library-open');
  }

  /* ---------------- 文章 ---------------- */
  function activeArticle() {
    if (state.article) return state.article;
    var id = DR.store.activeId();
    var a = id ? DR.store.getArticle(id) : null;
    if (!a) {
      var list = DR.store.articles();
      a = list.length ? list[0] : null;
      if (a) DR.store.setActive(a.id);
    }
    return a;
  }

  function show() {
    var a = activeArticle();
    if (a) {
      if (!state.article || state.article.id !== a.id || !state.rendered) openArticle(a.id);
      else renderLibrary();
    } else {
      renderWelcome();
    }
    refreshBadges();
  }

  function openArticle(id) {
    var a = DR.store.getArticle(id);
    if (!a) { renderWelcome(); return; }
    state.article = a;
    state.rendered = true;
    state.welcome = false;
    state.analyses = new Map();
    state.activeWord = '';
    state.activeSi = -1;
    state.rolesOn = false;
    state.rolesSi = -1;
    state.chapters = null;
    state.ci = 0;
    state.bookScroll = {};
    DR.store.setActive(a.id);
    document.title = (a.title || '未命名') + ' · 深读';
    DR.card.closeInspector();
    renderLibrary();
    closeLibrary();
    if (a.kind === 'book' && DR.books && DR.books.supported()) { openBook(a); return; }
    renderHead(a);
    renderBody(a.text || '');
    restoreScroll(a);
    refreshBadges();
  }

  /* ---------------- 电子书 ---------------- */
  function openBook(a) {
    DR.dom.clear(els.head);
    DR.dom.clear(els.body);
    els.head.appendChild(h('div', { class: 'reader__head-inner' },
      h('p', { class: 'eyebrow' }, 'BOOK · 电子书'),
      h('h1', { class: 'reader__title' }, a.title || '未命名'),
      h('p', { class: 'muted' }, '正在从本地书库打开…')
    ));
    DR.books.get(a.id).then(function (chapters) {
      if (!chapters || !chapters.length) {
        toast('这本书的正文没能读出来，可以删掉重新导入', { kind: 'warn' });
        return;
      }
      state.chapters = chapters;
      var ci = Math.max(0, Math.min(a.chapterIndex || 0, chapters.length - 1));
      renderChapter(ci, { restore: true });
      refreshBadges();
    }).catch(function (e) {
      toast(e && e.message ? e.message : '读取本地书库失败', { kind: 'warn' });
    });
  }

  function renderChapter(ci, opts) {
    opts = opts || {};
    var a = state.article;
    if (!a || !state.chapters) return;
    var ch = state.chapters[ci];
    if (!ch) return;
    if (state.chapters[state.ci] && opts.restore !== true) {
      state.bookScroll[state.ci] = els.scroll.scrollTop;
    }
    state.ci = ci;
    state.analyses = new Map();
    state.activeWord = '';
    state.activeSi = -1;
    state.rolesOn = false;
    state.rolesSi = -1;
    DR.card.closeInspector();
    renderHead(a);
    renderBody(ch.text || '');
    els.scroll.scrollTop = opts.restore ? (state.bookScroll[ci] || 0) : 0;
    a.chapterIndex = ci;
    DR.store.upsertArticle({ id: a.id, chapterIndex: ci });
    document.title = (ch.title ? ch.title + ' · ' : '') + (a.title || '') + ' · 深读';
    updateBookProgress();
  }

  function gotoChapter(ci) {
    if (!state.chapters) return;
    if (ci < 0 || ci >= state.chapters.length) return;
    if (state.chapters[state.ci]) state.bookScroll[state.ci] = els.scroll.scrollTop;
    renderChapter(ci);
  }

  function updateBookProgress() {
    var a = state.article;
    if (!a || !state.chapters || !state.chapters.length) return;
    var max = els.scroll.scrollHeight - els.scroll.clientHeight;
    var frac = max > 0 ? Math.min(1, Math.max(0, els.scroll.scrollTop / max)) : 0;
    var p = (state.ci + frac) / state.chapters.length;
    a.progress = p;
    var num = q('#read-progress');
    if (num) num.textContent = Math.round(p * 100) + '%';
    var bar = q('.library__item.is-active .library__bar i');
    if (bar) bar.style.width = Math.round(p * 100) + '%';
    return p;
  }

  function chapterNav(a) {
    var ch = state.chapters[state.ci] || {};
    var total = state.chapters.length;
    var prev = h('button', {
      class: 'btn btn--tiny chapter-nav__step', type: 'button', title: '上一章（←）',
      onclick: function () { gotoChapter(state.ci - 1); }
    }, '‹ 上一章');
    var next = h('button', {
      class: 'btn btn--tiny chapter-nav__step', type: 'button', title: '下一章（→）',
      onclick: function () { gotoChapter(state.ci + 1); }
    }, '下一章 ›');
    if (state.ci <= 0) prev.disabled = true;
    if (state.ci >= total - 1) next.disabled = true;
    var sel = h('select', {
      class: 'chapter-nav__select', id: 'chapter-select', title: '目录',
      onchange: function (e) { gotoChapter(parseInt(e.currentTarget.value, 10) || 0); }
    });
    state.chapters.forEach(function (c, i) {
      var label = (c.book ? c.book + ' · ' : '') + (c.title || ('第 ' + (i + 1) + ' 章'));
      var opt = h('option', { value: String(i) }, label);
      if (i === state.ci) opt.selected = true;
      sel.appendChild(opt);
    });
    var words = (ch.text || '').match(/[A-Za-z][A-Za-z'’-]*/g);
    return h('div', { class: 'chapter-nav', id: 'chapter-nav' },
      h('div', { class: 'chapter-nav__row' }, prev, sel, next),
      h('p', { class: 'chapter-nav__sub' },
        (ch.book ? ch.book + ' · ' : '') + (ch.title || ('第 ' + (state.ci + 1) + ' 章')) +
        (words ? ' · ' + words.length.toLocaleString('en-US') + ' 词' : '') +
        ' · 第 ' + (state.ci + 1) + '/' + total + ' 章')
    );
  }

  function renderWelcome() {
    state.article = null;
    state.rendered = false;
    state.welcome = true;
    document.title = '深读 DeepRead · 英语精读';
    DR.dom.clear(els.head);
    DR.dom.clear(els.body);
    els.head.appendChild(h('div', { class: 'welcome-head' },
      h('p', { class: 'eyebrow' }, 'DEEPREAD · 深读'),
      h('h1', { class: 'welcome-title' }, '把一篇文章放进来，慢慢读。'),
      h('p', { class: 'welcome-sub' }, '点词查本地四六级 / 专四专八词库；查过的词自动进生词本；点句子可以看成分。'))
    );
    var wrap = h('div', { class: 'welcome-actions' },
      h('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: openPaste }, '粘贴一篇文章'),
      h('button', { class: 'btn btn--lg', type: 'button', id: 'btn-load-sample', onclick: loadSample }, '先读示例')
    );
    els.body.appendChild(wrap);
    els.body.appendChild(h('div', { class: 'welcome-grid' },
      welcomeCard('01', '放进来', '粘贴正文，或导入 .txt / .md / .epub。电子书会自动认出书名、作者，按目录分好章。'),
      welcomeCard('02', '逐词查', '点击任意单词：音标、释义、词级、例句、词形与发音；不认识的词会标出词缀线索。'),
      welcomeCard('03', '留痕', '查过的词连同原句自动收进「生词本」，闪卡复习，按记忆曲线安排。'),
      welcomeCard('04', '看成分', '点顶部「成分」模式后，点句子任意位置；或按住 Alt 点击句子。主谓宾、从句、被动语态等，规则推断，仅作参考。')
    ));
    DR.card.closeInspector();
    renderLibrary();
    refreshBadges();
  }

  function welcomeCard(n, title, text) {
    return h('div', { class: 'welcome-card' },
      h('span', { class: 'welcome-card__n' }, n),
      h('h3', {}, title),
      h('p', {}, text));
  }

  function loadSample() {
    var exists = DR.store.getArticle(SAMPLE.id);
    if (!exists) {
      DR.store.upsertArticle({ id: SAMPLE.id, title: SAMPLE.title, text: SAMPLE.text, progress: 0 });
    }
    openArticle(SAMPLE.id);
    toast('已载入示例文章');
  }

  function renderHead(a) {
    DR.dom.clear(els.head);
    var isBook = !!(state.chapters && state.chapters.length);
    var curText = isBook ? ((state.chapters[state.ci] || {}).text || '') : (a.text || '');
    var stats = DR.text.stats(curText);
    var minutes = Math.max(1, Math.round(stats.wordCount / 200));
    var titleEl = h('h1', {
      class: 'reader__title', id: 'article-title', contenteditable: 'true',
      spellcheck: 'false', title: '点击可改标题'
    }, a.title || '未命名');
    titleEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    });
    titleEl.addEventListener('paste', function (e) {
      e.preventDefault();
      var t = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (t) document.execCommand('insertText', false, t.replace(/\s+/g, ' ').slice(0, 120));
    });
    titleEl.addEventListener('blur', function () {
      var t = titleEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名';
      titleEl.textContent = t;
      if (t !== a.title) {
        a.title = t;
        DR.store.upsertArticle({ id: a.id, title: t, text: a.kind === 'book' ? undefined : a.text });
        renderLibrary();
      }
    });

    var head = h('div', { class: 'reader__head-inner' },
      h('div', { class: 'reader__head-top' },
        h('p', { class: 'eyebrow' }, isBook ? 'BOOK · 电子书' : 'ARTICLE · 文章'),
        h('div', { class: 'reader__tools' },
          h('button', {
            class: 'btn btn--tiny' + (state.sentenceMode ? ' is-on' : ''), type: 'button',
            id: 'btn-sentence-mode', title: '成分模式：开启后点句子任意位置看成分（Alt + 点击随时可用）',
            onclick: toggleSentenceMode
          }, '成分'),
          h('button', {
            class: 'btn btn--tiny' + (DR.store.settings().marks ? ' is-on' : ''), type: 'button',
            id: 'btn-marks-toggle', title: '词级下划线：用颜色标出单词属于四级/六级/专四/专八',
            onclick: function (e) {
              var s = DR.store.settings();
              s.marks = !s.marks;
              DR.store.saveSettings(s);
              e.currentTarget.classList.toggle('is-on', s.marks);
              applyMarks();
            }
          }, '词级'),
          h('button', {
            class: 'btn btn--tiny', type: 'button', id: 'btn-read-aloud',
            onclick: function (e) { toggleReadAloud(a, e.currentTarget); }
          }, icon('speak', 15), '朗读'),
          h('button', {
            class: 'btn btn--tiny', type: 'button', id: 'btn-save-article',
            onclick: function () {
              DR.store.upsertArticle({ id: a.id, title: a.title, text: isBook ? undefined : a.text });
              toast('已保存到文章库');
            }
          }, '保存'),
          h('button', {
            class: 'btn btn--tiny btn--danger-ghost', type: 'button', id: 'btn-delete-article',
            onclick: function () { deleteArticle(a); }
          }, '删除')
        )
      ),
      titleEl,
      a.author ? h('p', { class: 'reader__author' }, 'by ' + a.author) : null,
      isBook ? chapterNav(a) : null,
      h('div', { class: 'reader__meta', id: 'article-meta' },
        h('span', {}, stats.wordCount.toLocaleString('en-US') + ' 词'),
        h('span', { class: 'sep' }, '·'),
        h('span', {}, stats.sentenceCount + ' 句'),
        h('span', { class: 'sep' }, '·'),
        h('span', {}, '约 ' + minutes + ' 分钟'),
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'progress-num', id: 'read-progress' }, Math.round((a.progress || 0) * 100) + '%'),
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'reader__hint', id: 'reader-hint' }, hintText())
      )
    );
    els.head.appendChild(head);
  }

  function deleteArticle(a) {
    if (!window.confirm('删除《' + (a.title || '未命名') + '》？生词本里的记录会保留。')) return;
    DR.store.removeArticle(a.id);
    if (a.kind === 'book' && DR.books) DR.books.del(a.id).catch(function () {});
    state.article = null;
    state.rendered = false;
    state.chapters = null;
    var next = DR.store.articles()[0];
    if (next) openArticle(next.id);
    else renderWelcome();
    toast('文章已删除');
  }

  function toggleReadAloud(a, btn) {
    if (btn.dataset.on === '1') {
      DR.tts.stop();
      btn.dataset.on = '0';
      btn.classList.remove('is-on');
      btn.childNodes[btn.childNodes.length - 1].nodeValue = '朗读';
      return;
    }
    if (!DR.tts.hasVoice()) { toast('系统里没有可用的英语语音', { kind: 'warn' }); return; }
    var spoken = (state.chapters && state.chapters[state.ci]) ? state.chapters[state.ci].text : a.text;
    DR.tts.speak(spoken || '');
    btn.dataset.on = '1';
    btn.classList.add('is-on');
    btn.childNodes[btn.childNodes.length - 1].nodeValue = '停止';
  }

  /* ---------------- 正文渲染 ---------------- */
  function renderBody(text) {
    DR.dom.clear(els.body);
    state.paragraphs = DR.text.paragraphs(text);
    state.sentences = [];
    var frag = document.createDocumentFragment();
    var si = 0;
    state.paragraphs.forEach(function (para) {
      var p = h('p', { class: 'para' });
      DR.text.splitSentences(para).forEach(function (sent) {
        var sEl = h('span', { class: 'sent', dataset: { si: String(si) }, title: '看句子成分' });
        DR.text.tokenize(sent.text).forEach(function (tok) {
          if (tok.k === 'w') {
            sEl.appendChild(h('span', { class: 'w', dataset: { w: tok.w } }, tok.t));
          } else {
            sEl.appendChild(document.createTextNode(tok.t));
          }
        });
        p.appendChild(sEl);
        p.appendChild(document.createTextNode(' '));
        state.sentences.push({ text: sent.text, el: sEl, si: si, para: p });
        si += 1;
      });
      frag.appendChild(p);
    });
    els.body.appendChild(frag);
    els.body.classList.toggle('no-marks', !DR.store.settings().marks);
    els.body.classList.toggle('sentence-mode', !!state.sentenceMode);
    applyMarks();
  }

  // 功能词不画词级线（它们在多套词库里都有，标出来只是噪音）
  var FUNCTION_WORDS = {};
  ('a an the and or but if because as than so yet for nor of to in on at by with from into onto over under about after before between during through without within up down out off again then once here there when where why how all any both each few more most other some such no not only own same too very can could will would shall should may might must do does did done be am is are was were been being have has had having i you he she it we they me him her us them my your his its our their this that these those who whom whose which what also just now while still even').split(' ').forEach(function (w) { FUNCTION_WORDS[w] = 1; });

  function levelClass(entry) {
    if (!entry || !entry.packs || !entry.packs.length) return '';
    // 专八词库本身收录了大量基础词；按「最低门槛」着色，否则全篇都会是专八色。
    var order = ['cet4', 'cet6', 'tem4', 'tem8', 'ielts', 'toefl'];
    for (var i = 0; i < order.length; i++) {
      if (entry.packs.indexOf(order[i]) >= 0) return 'lv-' + order[i];
    }
    return '';
  }

  function applyMarks() {
    var book = DR.store.notebook();
    var marksOn = DR.store.settings().marks;
    els.body.classList.toggle('no-marks', !marksOn);
    var spans = els.body.querySelectorAll('.w');
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      var w = sp.dataset.w;
      var cls = 'w';
      var entry = DR.dict.lookup(w);
      if (entry) {
        var lc = (marksOn && !FUNCTION_WORDS[w]) ? levelClass(entry) : '';
        if (lc) cls += ' ' + lc;
        var key = DR.store.bookKey(entry, w);
        var item = book.items[key];
        if (item) cls += item.status === 'known' ? ' w--known' : ' w--noted';
        if (isNoteDisabledRaw(entry)) cls = cls.replace(' w--known', '').replace(' w--noted', '');
      } else if (isCapitalized(w, sp.textContent)) {
        cls += ' w--propn';
      }
      sp.className = cls;
      if (w === state.activeWord) sp.classList.add('is-active');
    }
    // 恢复当前句子的着色
    if (state.rolesOn && state.rolesSi >= 0) paintRoles(state.rolesSi, true);
    applySentenceActive();
  }

  function isNoteDisabledRaw(entry) { return false; }
  function isCapitalized(w, text) {
    return text && text[0] === text[0].toUpperCase() && text[0] !== text[0].toLowerCase();
  }

  function applySentenceActive() {
    DR.dom.qa('.sent', els.body).forEach(function (s) {
      s.classList.toggle('is-active', Number(s.dataset.si) === state.activeSi);
    });
  }

  function onBodyClick(e) {
    // 拖选文本时不要误触发查词/句析
    var selection = window.getSelection ? String(window.getSelection()).trim() : '';
    if (selection.length > 1) return;
    var s = e.target.closest('.sent');
    var w = e.target.closest('.w');
    if (s && (e.altKey || state.sentenceMode)) {
      e.preventDefault();
      e.stopPropagation();
      openSentence(Number(s.dataset.si));
      return;
    }
    if (w) { e.stopPropagation(); openWord(w.dataset.w, { context: contextFor(w) }); return; }
    if (s) { openSentence(Number(s.dataset.si)); return; }
  }

  function toggleSentenceMode() {
    state.sentenceMode = !state.sentenceMode;
    var btn = q('#btn-sentence-mode');
    if (btn) {
      btn.classList.toggle('is-on', state.sentenceMode);
      btn.setAttribute('aria-pressed', state.sentenceMode ? 'true' : 'false');
    }
    if (els.body) els.body.classList.toggle('sentence-mode', state.sentenceMode);
    var hint = q('#reader-hint');
    if (hint) hint.textContent = hintText();
    toast(state.sentenceMode ? '成分模式：点句子任意位置看成分；再点一次关闭' : '逐词查词模式');
    if (state.sentenceMode && (state.activeWord || state.activeSi >= 0)) clearSelection();
  }

  function hintText() {
    return state.sentenceMode ? '成分模式 · 点任意句子看成分' : '点词查词 · Alt+点击看成分';
  }

  function contextFor(span) {
    var sent = span.closest('.sent');
    if (!sent) return null;
    var si = Number(sent.dataset.si);
    var rec = state.sentences[si];
    return {
      text: rec ? rec.text : '',
      si: si,
      articleId: state.article ? state.article.id : '',
      title: state.article ? (state.article.title || '') : ''
    };
  }

  /* ---------------- 点词 ---------------- */
  function openWord(raw, opts) {
    opts = opts || {};
    if (state.rolesOn && state.rolesSi >= 0) { clearRoles(state.rolesSi); state.rolesOn = false; state.rolesSi = -1; state.activeSi = -1; }
    closeLibrary();
    var spans = DR.dom.qa('.w[data-w="' + cssEscape(raw) + '"]', els.body);
    var target = spans[0] || null;
    if (spans.length) {
      DR.dom.qa('.w.is-active', els.body).forEach(function (x) { x.classList.remove('is-active'); });
      target.classList.add('is-active');
      state.activeWord = raw;
    }
    var context = opts.context || (target ? contextFor(target) : null);
    var settings = DR.store.settings();
    var result = DR.dict.resolve(raw);

    function show(entry) {
      if (settings.autoAdd && entry) {
        DR.store.addLookup(entry, context || null, { raw: raw });
        afterBookChange(raw);   // 立刻把 w--noted 灰底 / 生词本徽标刷出来
      }
      DR.card.setInspector(DR.card.word(entry, {
        raw: raw,
        context: context,
        onChanged: function () { afterBookChange(raw); },
        onClose: function () { clearSelection(); },
        onLemma: function (lemma) { openWord(lemma, { context: context }); },
        onAnalyzeSentence: (context && typeof context.si === 'number' && context.si >= 0) ? function () { openSentence(context.si); } : null
      }));
      if (window.innerWidth <= 860) document.body.classList.add('sheet-open');
    }

    if (result) { show(result.entry); return; }
    // 同步未命中：先给个占位卡，再按需加载兜底词典 / 扩展词库桶
    DR.card.setInspector(h('div', { class: 'card card--word', id: 'word-card' },
      h('div', { class: 'card__top' }, h('p', { class: 'eyebrow' }, 'WORD · 单词'),
        h('button', { class: 'icon-btn card__close', type: 'button', onclick: function () { DR.card.closeInspector(); } }, '×')),
      h('h2', { class: 'word' }, raw),
      h('p', { class: 'muted' }, '正在加载词库…')));
    var reqId = (state.wordReq = (state.wordReq || 0) + 1);
    DR.dict.resolveAsync(raw).then(function (r2) {
      if (state.wordReq !== reqId) return;   // 期间又点了别的词，别把旧结果画回去
      show(r2 ? r2.entry : null);
    });
  }

  function afterBookChange(raw) {
    refreshBadges();
    applyMarks();
    renderLibraryFoot();
    if (DR.notebook && DR.notebook.refreshIfVisible) DR.notebook.refreshIfVisible();
  }

  /* ---------------- 点句 ---------------- */
  function openSentence(si) {
    var rec = state.sentences[si];
    if (!rec) return;
    closeLibrary();
    DR.dom.qa('.w.is-active', els.body).forEach(function (x) { x.classList.remove('is-active'); });
    state.activeWord = '';
    state.activeSi = si;
    state.rolesOn = false;
    if (state.rolesSi >= 0 && state.rolesSi !== si) clearRoles(state.rolesSi);
    state.rolesSi = -1;
    applySentenceActive();
    DR.card.setInspector(DR.card.sentence(rec.text, null, { loading: true }));
    if (window.innerWidth <= 860) document.body.classList.add('sheet-open');

    if (!window.DR.analyze) {
      renderSentenceCard(si, null, { error: '分析引擎脚本未加载（js/engine/analyze.js）。' });
      return;
    }
    var cached = state.analyses.get(si);
    if (cached) { renderSentenceCard(si, cached); return; }
    Promise.resolve(DR.analyze.load()).then(function () {
      var res = DR.analyze.sentence(rec.text);
      state.analyses.set(si, res);
      if (state.activeSi === si) renderSentenceCard(si, res);
    }).catch(function (err) {
      if (state.activeSi === si) renderSentenceCard(si, null, { error: err && err.message ? err.message : String(err) });
    });
  }

  function renderSentenceCard(si, res, extra) {
    var rec = state.sentences[si];
    if (!rec) return;
    extra = extra || {};
    DR.card.setInspector(DR.card.sentence(rec.text, res, {
      loading: false,
      error: extra.error || '',
      rolesActive: state.rolesOn && state.rolesSi === si,
      onRoleToggle: function () { toggleRoles(si); },
      onClose: function () { clearSelection(); }
    }));
  }

  function toggleRoles(si) {
    state.rolesOn = !state.rolesOn;
    state.rolesSi = si;
    paintRoles(si, state.rolesOn);
    var rec = state.sentences[si];
    var res = state.analyses.get(si);
    DR.card.setInspector(DR.card.sentence(rec.text, res, {
      rolesActive: state.rolesOn,
      onRoleToggle: function () { toggleRoles(si); },
      onClose: function () { clearSelection(); }
    }));
  }

  function paintRoles(si, on) {
    var rec = state.sentences[si];
    if (!rec) return;
    var res = state.analyses.get(si);
    var spans = rec.el.querySelectorAll('.w');
    clearRoles(si);
    if (!on || !res || !Array.isArray(res.tokens)) return;
    res.tokens.forEach(function (t, i) {
      if (!spans[i]) return;
      if (t.role) spans[i].classList.add('role', 'role--' + t.role);
    });
  }
  function clearRoles(si) {
    var rec = state.sentences[si];
    if (!rec) return;
    DR.dom.qa('.w', rec.el).forEach(function (sp) {
      sp.className = sp.className.replace(/\brole--[a-z]+\b/g, '').replace(/\brole\b/g, '').replace(/\s+/g, ' ').trim();
    });
  }

  function clearSelection() {
    state.activeWord = '';
    state.activeSi = -1;
    state.rolesOn = false;
    state.rolesSi = -1;
    DR.dom.qa('.w.is-active', els.body).forEach(function (x) { x.classList.remove('is-active'); });
    applySentenceActive();
    DR.card.closeInspector();
    document.body.classList.remove('sheet-open');
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* ---------------- 滚动进度 ---------------- */
  function onScroll() {
    var a = state.article;
    if (!a) return;
    var max = els.scroll.scrollHeight - els.scroll.clientHeight;
    var p = max > 0 ? Math.min(1, Math.max(0, els.scroll.scrollTop / max)) : 0;
    var shown = p;
    if (state.chapters && state.chapters.length) {
      shown = (state.ci + p) / state.chapters.length;     // 整本书的进度
      state.bookScroll[state.ci] = els.scroll.scrollTop;
      a.progress = shown;
    }
    var num = q('#read-progress');
    if (num) num.textContent = Math.round(shown * 100) + '%';
    var bar = q('.library__item.is-active .library__bar i');
    if (bar) bar.style.width = Math.round(shown * 100) + '%';
    clearTimeout(scrollSave);
    scrollSave = setTimeout(function () { DR.store.touchProgress(a.id, shown); }, 500);
  }
  function restoreScroll(a) {
    var max = els.scroll.scrollHeight - els.scroll.clientHeight;
    els.scroll.scrollTop = Math.round((a.progress || 0) * Math.max(0, max));
  }

  /* ---------------- 粘贴 / 导入 ---------------- */
  function openPaste() {
    state.pendingBook = null;
    var ta = q('#paste-text');
    var ti = q('#paste-title');
    if (ta) ta.value = '';
    if (ti) ti.value = '';
    var au = q('#paste-author');
    if (au) au.value = '';
    clearBookPreview();
    var heading = q('#paste-heading');
    if (heading) heading.textContent = '粘贴一篇英文文章';
    var eyebrow = q('#paste-eyebrow');
    if (eyebrow) eyebrow.textContent = 'NEW ARTICLE';
    var goBtn = q('#btn-paste-start');
    if (goBtn) goBtn.textContent = '开始阅读';
    DR.ui.openModal('paste');
    setTimeout(function () { if (ta) ta.focus(); }, 120);
  }

  function clearBookPreview() {
    var box = q('#book-preview');
    if (box) box.hidden = true;
    var list = q('#book-chapters');
    if (list) DR.dom.clear(list);
    var tf = q('#paste-text-field');
    if (tf) tf.hidden = false;
    var af = q('#paste-author-field');
    if (af) af.hidden = true;
    var goBtn = q('#btn-paste-start');
    if (goBtn) goBtn.textContent = '开始阅读';
    updatePasteHint();
  }

  function showBookPreview(book) {
    state.pendingBook = { data: book };
    var box = q('#book-preview');
    var list = q('#book-chapters');
    var meta = q('#book-preview-meta');
    var tf = q('#paste-text-field');
    var af = q('#paste-author-field');
    if (tf) tf.hidden = true;
    if (af) af.hidden = false;
    if (box) box.hidden = false;
    if (q('#paste-title')) q('#paste-title').value = book.title || '';
    if (q('#paste-author')) q('#paste-author').value = book.author || '';
    var heading = q('#paste-heading');
    if (heading) heading.textContent = '导入电子书';
    var eyebrow = q('#paste-eyebrow');
    if (eyebrow) eyebrow.textContent = 'IMPORT EBOOK';
    var goBtn = q('#btn-paste-start');
    if (goBtn) goBtn.textContent = '导入';
    var countWords = function (s) { return (String(s).match(/[A-Za-z][A-Za-z'’-]*/g) || []).length; };
    if (list) {
      DR.dom.clear(list);
      var shown = book.chapters.slice(0, 80);
      shown.forEach(function (c, i) {
        list.appendChild(h('li', { class: 'book-preview__item' },
          h('span', { class: 'book-preview__n' }, String(i + 1).padStart(2, '0')),
          h('span', { class: 'book-preview__t' }, (c.book ? c.book + ' · ' : '') + (c.title || '未命名章节')),
          h('span', { class: 'book-preview__w' }, countWords(c.text).toLocaleString('en-US') + ' 词')
        ));
      });
      if (book.chapters.length > shown.length) {
        list.appendChild(h('li', { class: 'book-preview__more' }, '…… 共 ' + book.chapters.length + ' 章'));
      }
    }
    var words = book.chapters.reduce(function (a, c) { return a + countWords(c.text); }, 0);
    if (meta) {
      meta.textContent = book.chapters.length + ' 章 · ' + words.toLocaleString('en-US') + ' 词' +
        (book.language ? ' · ' + book.language : '') + ' · 正文存本机 IndexedDB';
    }
    setPasteStatus('解析完成；确认书名和作者后点「导入」');
  }

  function setPasteStatus(text) {
    var el = q('#paste-hint');
    if (el) el.textContent = text || '';
  }

  function bindPasteModal() {
    q('#btn-paste-start').addEventListener('click', createFromPaste);
    q('#paste-file-btn').addEventListener('click', function () { q('#paste-file').click(); });
    q('#paste-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) readFile(f);
      e.target.value = '';
    });
    var modal = q('#paste-modal');
    ['dragover', 'dragenter'].forEach(function (t) {
      modal.addEventListener(t, function (e) { e.preventDefault(); modal.classList.add('is-drop'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      modal.addEventListener(t, function (e) { e.preventDefault(); modal.classList.remove('is-drop'); });
    });
    modal.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { readFile(f); return; }
      var text = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (text) { q('#paste-text').value = text; updatePasteHint(); }
    });
    q('#paste-text').addEventListener('input', updatePasteHint);
  }

  function updatePasteHint() {
    if (state.pendingBook) return;
    var t = q('#paste-text').value || '';
    var s = DR.text.stats(t);
    var el = q('#paste-hint');
    if (!el) return;
    el.textContent = t ?
      (s.wordCount + ' 词 · ' + s.sentenceCount + ' 句 · 离线保存，不上传') :
      '离线可用，内容只保存在本机浏览器里。支持 .txt / .md / .epub。';
  }

  function readFile(f) {
    var name = String(f.name || '');
    if (/\.epub$/i.test(name) || f.type === 'application/epub+zip') {
      importBook(f);
      return;
    }
    if (!/\.(txt|md|markdown)$/i.test(name) && !/^text\//.test(f.type || '')) {
      toast('支持 .txt / .md / .epub', { kind: 'warn' });
      return;
    }
    var fr = new FileReader();
    fr.onload = function () {
      var text = String(fr.result || '');
      var stem = name.replace(/\.(txt|md|markdown)$/i, '');
      // 长篇小说类 txt：能分出多章就走「电子书」流程，否则照旧贴进正文框
      var parsed = null;
      try { parsed = DR.ebook ? DR.ebook.parseText(text, { title: stem, source: 'txt' }) : null; } catch (e) { parsed = null; }
      if (parsed && parsed.chapters.length >= 2) {
        if (!parsed.title) parsed.title = stem;
        showBookPreview(parsed);
        return;
      }
      q('#paste-text').value = text;
      if (!q('#paste-title').value) q('#paste-title').value = stem;
      updatePasteHint();
    };
    fr.readAsText(f, 'utf-8');
  }

  function importBook(f) {
    if (!DR.ebook) { toast('电子书解析脚本没加载（js/core/ebook.js）', { kind: 'warn' }); return; }
    if (!DR.books || !DR.books.supported()) { toast('这个浏览器不支持本地书库（IndexedDB）', { kind: 'warn' }); return; }
    setPasteStatus('正在解析《' + f.name + '》…');
    DR.ebook.parseFile(f).then(function (book) {
      if (!book.chapters || !book.chapters.length) throw new Error('没从这本电子书里读到章节');
      showBookPreview(book);
      toast('解析完成：' + book.chapters.length + ' 章');
    }).catch(function (e) {
      console.error(e);
      setPasteStatus('解析失败：' + (e && e.message ? e.message : '未知错误'));
      toast('解析失败：' + (e && e.message ? e.message : ''), { kind: 'warn' });
    });
  }

  function countWords(s) {
    return (String(s || '').match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  }

  function saveBook() {
    var parsed = state.pendingBook.data;
    var title = (q('#paste-title').value || parsed.title || '未命名').trim();
    var author = (q('#paste-author').value || parsed.author || '').trim();
    var id = DR.dom.uid();
    var chapters = parsed.chapters.map(function (c) {
      return { title: c.title || '', book: c.book || '', text: c.text };
    });
    var total = chapters.reduce(function (a, c) { return a + countWords(c.text); }, 0);
    var meta = {
      id: id, title: title, author: author, kind: 'book',
      chapterCount: chapters.length,
      chapterTitles: chapters.map(function (c) { return c.title; }).slice(0, 300),
      wordCount: total, progress: 0, chapterIndex: 0, source: parsed.source || 'epub'
    };
    DR.books.put(id, chapters).then(function () {
      DR.store.upsertArticle(meta);
      DR.store.setActive(id);
      state.pendingBook = null;
      DR.ui.closeModal();
      openArticle(id);
      toast('《' + title + '》已导入：' + chapters.length + ' 章 / ' + total.toLocaleString('en-US') + ' 词');
    }).catch(function (e) {
      console.error(e);
      toast('保存失败：' + (e && e.message ? e.message : '本地书库写入失败'), { kind: 'warn' });
    });
  }

  function deriveTitle(text) {
    var st = DR.text.stats(text);
    var first = st.sentences.length ? st.sentences[0].text : String(text).split('\n')[0];
    var t = String(first || '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    if (t.length > 58) {
      t = t.slice(0, 58);
      var cut = Math.max(t.lastIndexOf(' '), t.lastIndexOf('，'), t.lastIndexOf(','));
      if (cut > 22) t = t.slice(0, cut);
      t = t.trim() + '…';
    }
    t = t.replace(/[.!?。！？,，;；:：]+$/, '');
    return t || '未命名文章';
  }

  function createFromPaste() {
    if (state.pendingBook) { saveBook(); return; }
    var text = (q('#paste-text').value || '').trim();
    if (!text) { toast('先粘贴一点正文吧', { kind: 'warn' }); return; }
    if (text.length < 20) { toast('文章太短了，再多贴一点', { kind: 'warn' }); return; }
    var title = (q('#paste-title').value || '').trim();
    if (!title) title = deriveTitle(text);
    var a = { id: DR.dom.uid(), title: title, text: text, progress: 0 };
    DR.store.upsertArticle(a);
    DR.store.setActive(a.id);
    DR.ui.closeModal();
    openArticle(a.id);
    toast('文章已添加');
  }

  function refreshBadges() {
    var n = DR.store.bookStats().total;
    var badge = q('#nb-count');
    if (badge) {
      badge.textContent = n;
      badge.hidden = n === 0;
    }
    renderLibraryFoot();
  }

  DR.reader = {
    init: init, show: show, openArticle: openArticle, openWord: openWord,
    openSentence: openSentence, renderLibrary: renderLibrary, renderWelcome: renderWelcome,
    loadSample: loadSample, refreshBadges: refreshBadges, refreshMarks: applyMarks,
    clearSelection: clearSelection, openPaste: openPaste, toggleLibrary: toggleLibrary,
    state: state,
    sample: SAMPLE
  };
})();
