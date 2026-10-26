/* 极简 DOM 工具：h() 造节点、查询、事件委托、转义。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  function isNode(x) { return x && typeof x === 'object' && typeof x.nodeType === 'number'; }

  function h(tag, attrs) {
    var kids = Array.prototype.slice.call(arguments, 2);
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class' || k === 'className') el.setAttribute('class', v);
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (s) { el.style.setProperty(s, v[s]); });
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    appendKids(el, kids);
    return el;
  }

  function appendKids(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false) continue;
      if (Array.isArray(k)) appendKids(el, k);
      else if (isNode(k)) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    }
  }

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
  function on(root, type, sel, fn) {
    root.addEventListener(type, function (e) {
      var t = e.target;
      while (t && t !== root) {
        if (t.matches && t.matches(sel)) { fn.call(t, e, t); return; }
        t = t.parentNode;
      }
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function svg(paths, size, cls) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', size || 18);
    el.setAttribute('height', size || 18);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '1.7');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    if (cls) el.setAttribute('class', cls);
    (paths || []).forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      el.appendChild(p);
    });
    return el;
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
    };
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function relTime(ts) {
    var diff = Date.now() - ts;
    var m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return fmtDate(ts);
  }
  function uid() {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  DR.dom = { h: h, q: q, qa: qa, clear: clear, on: on, esc: esc, svg: svg, debounce: debounce, fmtDate: fmtDate, relTime: relTime, uid: uid };
})();
