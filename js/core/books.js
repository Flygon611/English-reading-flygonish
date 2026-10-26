/* 大书正文的存放：章节正文放 IndexedDB，localStorage 只留书目元数据。
   localStorage 单域名约 5MB，一本哈利波特就有百万词（约 6MB），塞不进去；
   章节按文章 id 一条记录，读一章才取一章。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  var DB_NAME = 'deepread';
  var DB_VER = 1;
  var STORE = 'chapters';
  var dbPromise = null;

  function supported() {
    return typeof indexedDB !== 'undefined';
  }

  function openDb() {
    if (!supported()) return Promise.reject(new Error('这个浏览器不支持 IndexedDB'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打开本地书库失败')); };
      req.onblocked = function () { reject(new Error('本地书库被其它标签页占用')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error || new Error('书库写入失败')); };
        t.onabort = function () { reject(t.error || new Error('书库写入被中止')); };
      });
    });
  }

  function put(id, chapters) {
    return tx('readwrite', function (store) {
      return store.put({ id: id, v: 1, chapters: chapters, savedAt: Date.now() });
    });
  }

  function get(id) {
    return tx('readonly', function (store) { return store.get(id); })
      .then(function (rec) { return rec && Array.isArray(rec.chapters) ? rec.chapters : null; });
  }

  /* 备份用：取出全部书籍记录 [{ id, chapters, savedAt }] */
  function all() {
    return tx('readonly', function (store) { return store.getAll(); })
      .then(function (recs) { return Array.isArray(recs) ? recs : []; });
  }

  function del(id) {
    return tx('readwrite', function (store) { return store.delete(id); });
  }

  function has(id) {
    return tx('readonly', function (store) { return store.count(id); }).then(function (n) { return n > 0; });
  }

  function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().catch(function () { return null; });
  }

  DR.books = { supported: supported, put: put, get: get, all: all, del: del, has: has, usage: usage };
})();
