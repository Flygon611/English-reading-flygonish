/* localStorage 封装 + 文章库 + 生词本（含间隔重复）+ 设置。所有 key 前缀 dr. */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  var KEYS = {
    articles: 'dr.articles.v1',
    notebook: 'dr.notebook.v1',
    settings: 'dr.settings.v1',
    stats: 'dr.stats.v1',
    active: 'dr.active.v1'
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('localStorage write failed', e); return false; }
  }
  function remove(key) { try { localStorage.removeItem(key); } catch (e) {} }

  /* ---------- 设置 ---------- */
  var DEFAULT_SETTINGS = {
    v: 1, theme: 'auto', fontScale: 1, lineHeight: 1.9,
    marks: false, autoAdd: true, showRoles: false,
    readFont: 'newsreader', customFont: '', reviewMode: 'mix'
  };
  function settings() {
    var s = read(KEYS.settings, null);
    var out = Object.assign({}, DEFAULT_SETTINGS, s || {});
    if (!/^(newsreader|literata|garamond|mono|sans|system|custom)$/.test(String(out.readFont))) out.readFont = 'newsreader';
    return out;
  }
  function saveSettings(s) { write(KEYS.settings, Object.assign({}, DEFAULT_SETTINGS, s)); }

  /* ---------- 文章库 ---------- */
  function articles() {
    var list = read(KEYS.articles, []);
    return Array.isArray(list) ? list : [];
  }
  function saveArticles(list) { write(KEYS.articles, list); }
  function activeId() { return read(KEYS.active, ''); }
  function setActive(id) { write(KEYS.active, id); }
  function getArticle(id) {
    var list = articles();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function upsertArticle(a) {
    var list = articles();
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === a.id) {
        list[i] = Object.assign({}, list[i], a, { updatedAt: Date.now() });
        found = true;
        break;
      }
    }
    if (!found) {
      a.createdAt = a.createdAt || Date.now();
      a.updatedAt = Date.now();
      a.progress = a.progress || 0;
      list.unshift(a);
    }
    saveArticles(list);
    return a;
  }
  function removeArticle(id) {
    var list = articles().filter(function (a) { return a.id !== id; });
    saveArticles(list);
    if (activeId() === id) setActive(list.length ? list[0].id : '');
  }
  function touchProgress(id, p) {
    var list = articles();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        list[i].progress = Math.max(0, Math.min(1, p));
        list[i].updatedAt = Date.now();
        break;
      }
    }
    saveArticles(list);
  }

  /* ---------- 生词本 ---------- */
  function emptyBook() { return { v: 1, order: [], items: {} }; }
  function notebook() {
    var b = read(KEYS.notebook, null);
    if (!b || typeof b !== 'object' || !b.items) return emptyBook();
    b.order = Array.isArray(b.order) ? b.order : Object.keys(b.items);
    return b;
  }
  function saveNotebook(b) { write(KEYS.notebook, b); }

  function bookKey(entry, raw) {
    var k = (entry && entry.w ? entry.w : raw || '').toLowerCase();
    return k.replace(/^[^a-z]+|[^a-z']+$/g, '');
  }

  function addLookup(entry, ctx, opts) {
    opts = opts || {};
    var b = notebook();
    var key = bookKey(entry, opts.raw);
    if (!key) return null;
    var now = Date.now();
    var item = b.items[key];
    var isNew = !item;
    if (!item) {
      item = {
        key: key,
        w: opts.raw || entry.w || key,
        lemma: (entry.w || key).toLowerCase(),
        ipa: entry.ipa || '',
        zh: entry.zh || '',
        packs: entry.packs || [],
        ex: entry.ex || '',
        exZh: entry.exZh || '',
        forms: entry.forms || [],
        firstAt: now, lastAt: now, count: 1,
        status: 'new', dueAt: now, interval: 0, ease: 2.5, reps: 0, lapses: 0,
        contexts: []
      };
      b.items[key] = item;
      b.order.unshift(key);
    } else {
      item.count = (item.count || 1) + 1;
      item.lastAt = now;
      if (entry.zh && !item.zh) item.zh = entry.zh;
      if (entry.ipa && !item.ipa) item.ipa = entry.ipa;
      if (entry.packs && entry.packs.length) item.packs = entry.packs;
    }
    if (ctx && ctx.text) {
      item.contexts = item.contexts || [];
      var dup = item.contexts.some(function (c) { return c.text === ctx.text; });
      if (!dup) {
        item.contexts.unshift(Object.assign({ text: ctx.text, at: now }, ctx));
        if (item.contexts.length > 5) item.contexts.length = 5;
      }
    }
    saveNotebook(b);
    bumpStat('looked');
    if (isNew && !opts.silent) bumpStat('added');
    return item;
  }

  function getItem(key) { var b = notebook(); return b.items[key] || null; }
  function removeItem(key) {
    var b = notebook();
    if (b.items[key]) {
      delete b.items[key];
      b.order = b.order.filter(function (k) { return k !== key; });
      saveNotebook(b);
    }
  }
  function setStatus(key, status) {
    var b = notebook();
    var it = b.items[key];
    if (!it) return;
    it.status = status;
    if (status === 'known') { it.dueAt = Date.now() + 30 * 864e5; it.interval = Math.max(it.interval || 0, 30); }
    if (status === 'learning') { it.dueAt = Date.now(); }
    saveNotebook(b);
  }
  function dueList(limit) {
    var b = notebook();
    var now = Date.now();
    var arr = b.order.map(function (k) { return b.items[k]; }).filter(Boolean);
    var due = arr.filter(function (it) { return it.status !== 'known' && (it.dueAt || 0) <= now; });
    due.sort(function (a, c) { return (a.dueAt || 0) - (c.dueAt || 0); });
    return due.slice(0, limit || 20);
  }
  function anyList(limit) {
    var b = notebook();
    var arr = b.order.map(function (k) { return b.items[k]; }).filter(Boolean);
    var pool = arr.filter(function (it) { return it.status !== 'known'; });
    if (!pool.length) pool = arr.slice();
    pool.sort(function () { return Math.random() - 0.5; });
    return pool.slice(0, limit || 10);
  }
  function rate(key, rating) {
    var b = notebook();
    var it = b.items[key];
    if (!it) return null;
    var ease = it.ease || 2.5;
    var interval = it.interval || 0;
    it.reps = (it.reps || 0) + 1;
    if (rating === 1) {
      it.lapses = (it.lapses || 0) + 1;
      ease = Math.max(1.3, ease - 0.2);
      interval = 0.02;          // 约 30 分钟后再来
      it.status = 'learning';
    } else if (rating === 2) {
      ease = Math.max(1.3, ease - 0.05);
      interval = interval < 1 ? 0.5 : Math.max(1, Math.round(interval * 1.6));
      it.status = 'learning';
    } else {
      interval = interval < 1 ? 1 : Math.max(1, Math.round(interval * 2.3));
      if (it.status !== 'new') it.status = interval >= 7 ? 'known' : 'learning';
      else it.status = 'learning';
    }
    it.ease = Math.round(ease * 100) / 100;
    it.interval = interval;
    it.dueAt = Date.now() + Math.round(interval * 864e5);
    it.lastAt = Date.now();
    it.lastRating = rating;
    saveNotebook(b);
    bumpStat('reviewed');
    return it;
  }
  function bookStats() {
    var b = notebook();
    var arr = b.order.map(function (k) { return b.items[k]; }).filter(Boolean);
    var now = Date.now();
    return {
      total: arr.length,
      known: arr.filter(function (i) { return i.status === 'known'; }).length,
      learning: arr.filter(function (i) { return i.status === 'learning'; }).length,
      fresh: arr.filter(function (i) { return i.status === 'new'; }).length,
      due: arr.filter(function (i) { return i.status !== 'known' && (i.dueAt || 0) <= now; }).length
    };
  }

  /* ---------- 统计 ---------- */
  function dayKey(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function stats() { return read(KEYS.stats, { v: 1, byDay: {} }); }
  function bumpStat(field, n) {
    var s = stats();
    var d = dayKey();
    s.byDay[d] = s.byDay[d] || { looked: 0, added: 0, reviewed: 0 };
    s.byDay[d][field] = (s.byDay[d][field] || 0) + (n || 1);
    write(KEYS.stats, s);
    return s;
  }
  function todayStats() {
    var s = stats();
    return s.byDay[dayKey()] || { looked: 0, added: 0, reviewed: 0 };
  }

  /* ---------- 导入导出 ---------- */
  function exportAll() {
    return {
      app: 'DeepRead', v: 1, exportedAt: new Date().toISOString(),
      articles: articles(), notebook: notebook(), settings: settings(), stats: stats()
    };
  }
  function importAll(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('文件格式不对');
    if (Array.isArray(obj.articles)) saveArticles(obj.articles);
    if (obj.notebook && obj.notebook.items) saveNotebook(obj.notebook);
    if (obj.settings) saveSettings(obj.settings);
    if (obj.stats && obj.stats.byDay) write(KEYS.stats, obj.stats);
  }

  DR.store = {
    KEYS: KEYS, read: read, write: write, remove: remove,
    settings: settings, saveSettings: saveSettings,
    articles: articles, saveArticles: saveArticles, getArticle: getArticle,
    upsertArticle: upsertArticle, removeArticle: removeArticle,
    activeId: activeId, setActive: setActive, touchProgress: touchProgress,
    notebook: notebook, saveNotebook: saveNotebook,
    addLookup: addLookup, getItem: getItem, removeItem: removeItem, setStatus: setStatus,
    dueList: dueList, anyList: anyList, rate: rate, bookStats: bookStats, bookKey: bookKey,
    bumpStat: bumpStat, todayStats: todayStats, stats: stats,
    exportAll: exportAll, importAll: importAll
  };
})();
