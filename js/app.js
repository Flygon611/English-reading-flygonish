/* 应用引导：主题、TAB 路由、顶部栏、快捷键、调试接口。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var q = function (s) { return DR.dom.q(s); };
  var qa = function (s) { return DR.dom.qa(s); };
  var icon = function (n, s) { return DR.ui.icon(n, s); };

  var media = null;

  function boot() {
    DR.settings.init();
    DR.dict.init();
    DR.reader.init();
    DR.notebook.init();
    DR.dictionary.init();

    wireChrome();
    fillStaticIcons();
    DR.settings.apply();
    DR.router.onChange(onRoute);
    DR.router.init();
    DR.reader.refreshBadges();
    syncChrome();

    document.addEventListener('keydown', onKey);
    if (window.matchMedia) {
      media = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (DR.store.settings().theme === 'auto') DR.settings.apply();
      };
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    }
    document.documentElement.classList.add('is-ready');
    setTimeout(function () {
      if (DR.dict && !DR.dict.hasFull()) DR.dict.ensureFull().catch(function () {});
    }, 2600);
    console.log('%c深读 DeepRead ready', 'color:#2F6F6A;font-weight:600');
  }

  function onRoute(route) {
    qa('.view').forEach(function (v) {
      v.hidden = v.dataset.view !== route;
    });
    qa('#tabs .tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.tab === route);
      if (t.dataset.tab === route) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    document.body.dataset.view = route;
    // 同一时刻只允许存在一份词卡（阅读页 #inspector 与词库页 #dict-detail 都含 #word-card）
    if (route !== 'read' && DR.reader) DR.reader.clearSelection();
    if (route !== 'dict' && DR.dictionary && DR.dictionary.closeDetail) DR.dictionary.closeDetail();
    if (route === 'read') { DR.reader.show(); DR.reader.refreshMarks(); }
    else if (route === 'notebook') DR.notebook.show();
    else if (route === 'dict') DR.dictionary.show();
    DR.reader.refreshBadges();
    syncChrome();
  }

  function wireChrome() {
    q('#theme-toggle').addEventListener('click', function () {
      var s = DR.store.settings();
      var current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      s.theme = current === 'dark' ? 'light' : 'dark';
      DR.store.saveSettings(s);
      DR.settings.apply();
      DR.ui.toast(s.theme === 'dark' ? '深色模式' : '浅色模式');
    });
    q('#font-dec').addEventListener('click', function () { zoomFont(-0.05); });
    q('#font-inc').addEventListener('click', function () { zoomFont(0.05); });
    q('#settings-open').addEventListener('click', function () { DR.settings.open(); });
    q('#modal-layer').addEventListener('click', function (e) {
      if (e.target === q('#modal-layer')) DR.ui.closeModal();
    });
    qa('[data-close]').forEach(function (b) { b.addEventListener('click', function () { DR.ui.closeModal(); }); });
  }

  function fillStaticIcons() {
    var map = { '#library-toggle': 'menu', '#settings-open': 'gear', '#btn-new-article': 'plus' };
    Object.keys(map).forEach(function (sel) {
      var el = q(sel);
      if (el && !el.firstChild) el.appendChild(icon(map[sel], 18));
    });
    qa('.modal__close').forEach(function (b) { if (!b.firstChild) b.textContent = '×'; });
  }

  function zoomFont(delta) {
    var s = DR.store.settings();
    var next = Math.round((s.fontScale + delta) * 100) / 100;
    next = Math.max(0.85, Math.min(1.35, next));
    s.fontScale = next;
    DR.store.saveSettings(s);
    DR.settings.apply();
    DR.ui.toast('字号 ' + Math.round(next * 100) + '%', { duration: 1200 });
  }

  function syncChrome() {
    var theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    var t = q('#theme-toggle');
    if (t) {
      DR.dom.clear(t);
      t.appendChild(icon(theme === 'dark' ? 'sun' : 'moon', 18));
      t.setAttribute('title', theme === 'dark' ? '切换到浅色' : '切换到深色');
    }
    var s = DR.store.settings();
    var dec = q('#font-dec'), inc = q('#font-inc');
    if (dec) dec.disabled = s.fontScale <= 0.86;
    if (inc) inc.disabled = s.fontScale >= 1.34;
  }

  function onKey(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (DR.router.current() !== 'dict') {
        DR.router.go('dict');
        setTimeout(function () { DR.dictionary.focusSearch(); }, 120);
      } else DR.dictionary.focusSearch();
      return;
    }
    if (e.key === 'Escape' && DR.ui.currentModal()) {
      DR.ui.closeModal();
    }
  }

  DR.app = { boot: boot, syncChrome: syncChrome, onRoute: onRoute };

  DR.debug = {
    route: function () { return DR.router.current(); },
    state: function () {
      return {
        route: DR.router.current(),
        articles: DR.store.articles().length,
        activeArticle: DR.store.activeId(),
        notebook: DR.store.bookStats(),
        settings: DR.store.settings(),
        dict: DR.dict.stats(),
        analysis: !!(window.DR && DR.analyze && DR.analyze.ready && DR.analyze.ready())
      };
    },
    openArticle: function (id) { DR.router.go('read'); DR.reader.openArticle(id); },
    clickWord: function (w) {
      var spans = DR.dom.qa('#article-body .w[data-w]');
      for (var i = 0; i < spans.length; i++) if (spans[i].dataset.w === String(w).toLowerCase()) { spans[i].click(); return true; }
      return false;
    },
    analyze: function (text) {
      if (!window.DR || !DR.analyze) return null;
      return DR.analyze.sentence(text);
    },
    resetStorage: function () {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('dr.') === 0) localStorage.removeItem(k); });
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
