/* 极简 hash 路由：只服务三个主 TAB。#/read #/notebook #/dict */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var ROUTES = ['read', 'notebook', 'dict'];
  var current = null;
  var listeners = [];

  function parse() {
    var raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
    if (!raw) return 'read';
    var r = raw.split('/')[0];
    return ROUTES.indexOf(r) >= 0 ? r : 'read';
  }
  function go(route) {
    if (ROUTES.indexOf(route) < 0) route = 'read';
    if (location.hash !== '#/' + route) location.hash = '#/' + route;
    else apply();
  }
  function apply() {
    var r = parse();
    if (r === current) { render(); return; }
    current = r;
    render();
  }
  function render() {
    listeners.forEach(function (fn) { try { fn(current); } catch (e) { console.error(e); } });
  }
  function onChange(fn) { listeners.push(fn); }
  function init() {
    window.addEventListener('hashchange', apply);
    if (!location.hash) history.replaceState(null, '', '#/read');
    apply();
    return current;
  }

  DR.router = { ROUTES: ROUTES, init: init, go: go, onChange: onChange, current: function () { return current; }, apply: apply };
})();
