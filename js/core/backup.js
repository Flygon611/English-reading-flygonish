/* 备份：把整个书架（含电子书正文与阅读进度）打包成一个 .json 文件，带到别的设备再导入。
   v2 格式：
     { app:'DeepRead', v:2, exportedAt, activeId,
       articles:[...],                    // 文章 / 书目元数据（含 progress、chapterIndex）
       books:{ [articleId]: [ {title, book, text} ] },   // 电子书正文（存 IndexedDB 的那部分）
       notebook, settings, stats }
   老版本 v1 备份（没有 books 字段）仍可导入，只是电子书正文不在里面。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var VERSION = 2;

  function build() {
    var base = DR.store.exportAll();
    var getBooks = (DR.books && DR.books.supported())
      ? DR.books.all().catch(function () { return []; })
      : Promise.resolve([]);
    return getBooks.then(function (recs) {
      var books = {};
      (recs || []).forEach(function (r) {
        if (r && r.id && Array.isArray(r.chapters)) books[r.id] = r.chapters;
      });
      base.app = 'DeepRead';
      base.v = VERSION;
      base.exportedAt = new Date().toISOString();
      base.activeId = DR.store.activeId();
      base.books = books;
      return base;
    });
  }

  function statsOf(bundle) {
    var articles = Array.isArray(bundle.articles) ? bundle.articles : [];
    var bookCount = articles.filter(function (a) { return a && a.kind === 'book'; }).length;
    var chapters = 0;
    Object.keys(bundle.books || {}).forEach(function (id) {
      var arr = bundle.books[id];
      if (Array.isArray(arr)) chapters += arr.length;
    });
    var words = 0;
    articles.forEach(function (a) {
      if (a && a.kind === 'book') words += a.wordCount || 0;
      else if (a && a.text) words += (a.text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
    });
    return {
      articles: articles.length, books: bookCount, chapters: chapters, words: words,
      notes: bundle.notebook && bundle.notebook.items ? Object.keys(bundle.notebook.items).length : 0
    };
  }

  function toJSON(bundle) {
    return JSON.stringify(bundle);
  }

  function download(bundle) {
    var json = toJSON(bundle || null);
    var size = new Blob([json]).size;
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    var name = 'deepread-backup-' + stamp + '.json';
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 800);
    return { name: name, bytes: size, stats: statsOf(bundle) };
  }

  function mergeById(local, incoming) {
    var map = Object.create(null);
    (local || []).forEach(function (a) { if (a && a.id) map[a.id] = a; });
    (incoming || []).forEach(function (a) { if (a && a.id) map[a.id] = a; });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    });
  }

  function mergeNotebook(local, incoming) {
    var out = { v: 1, order: [], items: {} };
    var push = function (b) {
      if (!b || !b.items) return;
      Object.keys(b.items).forEach(function (k) {
        if (!out.items[k]) out.order.push(k);
        out.items[k] = b.items[k];
      });
    };
    push(local); push(incoming);
    out.order = out.order.filter(function (k) { return out.items[k]; });
    return out;
  }

  /* opts.mode: 'merge'（默认，同 id 以文件为准）| 'replace'（先清空本地） */
  function importBundle(obj, opts) {
    opts = opts || {};
    if (!obj || typeof obj !== 'object') return Promise.reject(new Error('不是有效的备份文件'));
    if (obj.app && obj.app !== 'DeepRead') return Promise.reject(new Error('这不是深读的备份文件'));
    var incoming = Array.isArray(obj.articles) ? obj.articles : [];
    var books = obj.books && typeof obj.books === 'object' ? obj.books : null;
    var mode = opts.mode === 'replace' ? 'replace' : 'merge';

    var puts = [];
    if (DR.books && DR.books.supported() && books) {
      Object.keys(books).forEach(function (id) {
        var chapters = books[id];
        if (Array.isArray(chapters) && chapters.length) puts.push(DR.books.put(id, chapters));
      });
    }

    return Promise.all(puts).then(function () {
      var articles;
      if (mode === 'replace') {
        articles = incoming;
        DR.store.saveArticles(articles);
        if (books) {
          // 覆盖模式：把本地多余的书也清掉
          return DR.books.all().then(function (recs) {
            var keep = Object.create(null);
            incoming.forEach(function (a) { if (a && a.id) keep[a.id] = 1; });
            var dels = (recs || []).filter(function (r) { return !keep[r.id]; })
              .map(function (r) { return DR.books.del(r.id).catch(function () {}); });
            return Promise.all(dels);
          }).then(function () { return finish(articles, obj, incoming); });
        }
        return finish(articles, obj, incoming);
      }
      articles = mergeById(DR.store.articles(), incoming);
      DR.store.saveArticles(articles);
      return finish(articles, obj, incoming);
    });

    function finish(articles, objIn, list) {
      if (objIn.notebook && objIn.notebook.items) {
        DR.store.saveNotebook(mode === 'replace' ? objIn.notebook : mergeNotebook(DR.store.notebook(), objIn.notebook));
      }
      if (objIn.settings) DR.store.saveSettings(objIn.settings);
      if (objIn.stats && objIn.stats.byDay) DR.store.write(DR.store.KEYS.stats, objIn.stats);
      if (objIn.activeId) DR.store.setActive(objIn.activeId);
      var booksWithText = (list || []).filter(function (a) { return a && a.kind === 'book'; }).length;
      return {
        articles: articles.length, imported: (list || []).length,
        books: booksWithText, mode: mode, stats: statsOf(objIn)
      };
    }
  }

  DR.backup = {
    build: build, download: download, toJSON: toJSON,
    importBundle: importBundle, statsOf: statsOf, VERSION: VERSION
  };
})();
