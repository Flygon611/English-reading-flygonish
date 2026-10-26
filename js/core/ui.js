/* UI 基础件：图标、提示条、模态框、标签徽章。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var h = function () { return DR.dom.h.apply(null, arguments); };

  var ICONS = {
    speaker: ['M11 5 6 9H3v6h3l5 4z', 'M15.5 8.5a4.5 4.5 0 0 1 0 7'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    plus: ['M12 5v14', 'M5 12h14'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
    check: ['M4 12l5 5L20 6'],
    search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
    sun: ['M12 4V2', 'M12 22v-2', 'M4 12H2', 'M22 12h-2', 'M5.6 5.6 4.2 4.2', 'M19.8 19.8l-1.4-1.4', 'M5.6 18.4l-1.4 1.4', 'M19.8 4.2l-1.4 1.4', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
    moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
    gear: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.01a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.59z'],
    book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M4 5.5v15', 'M8 7h8', 'M8 11h6'],
    arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
    chevron: ['M6 9l6 6 6-6'],
    refresh: ['M20 11a8 8 0 1 0-2.3 6.6', 'M20 4v7h-7'],
    download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
    upload: ['M12 20V8', 'M7 13l5-5 5 5', 'M4 4h16'],
    layers: ['M12 3 2 8l10 5 10-5z', 'M2 13l10 5 10-5'],
    eye: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
    menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
    speak: ['M11 5 6 9H3v6h3l5 4z', 'M15.5 8.5a4.5 4.5 0 0 1 0 7', 'M18.5 5.5a8 8 0 0 1 0 13'],
    play: ['M7 4l13 8-13 8z'],
    stop: ['M6 6h12v12H6z'],
    clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
    spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M6 6l3 3', 'M15 15l3 3', 'M6 18l3-3', 'M15 9l3-3'],
    doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6']
  };

  function icon(name, size) {
    return DR.dom.svg(ICONS[name] || ICONS.spark, size || 18);
  }

  var toastTimer = null;
  function toast(msg, opts) {
    opts = opts || {};
    var layer = document.getElementById('toast-layer');
    if (!layer) return;
    while (layer.children.length >= 2) layer.removeChild(layer.firstChild);
    var el = h('div', { class: 'toast' + (opts.kind ? ' toast--' + opts.kind : '') }, msg);
    layer.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('is-in'); });
    setTimeout(function () {
      el.classList.remove('is-in');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }, opts.duration || 2200);
    return el;
  }

  function openModal(name) {
    var layer = document.getElementById('modal-layer');
    if (!layer) return;
    DR.dom.qa('.modal', layer).forEach(function (m) {
      var on = m.dataset.modal === name;
      m.hidden = !on;
      m.classList.toggle('is-open', on);
    });
    layer.hidden = false;
    layer.classList.add('is-open');
    document.body.classList.add('is-modal-open');
    var modal = layer.querySelector('.modal.is-open');
    var target = modal && modal.querySelector('textarea, input:not([type="hidden"])');
    var panel = modal && modal.querySelector('.modal__panel');
    setTimeout(function () {
      try {
        if (target) target.focus();
        else if (panel) { panel.setAttribute('tabindex', '-1'); panel.focus(); }
      } catch (e) {}
    }, 30);
  }
  function closeModal() {
    var layer = document.getElementById('modal-layer');
    if (!layer) return;
    layer.classList.remove('is-open');
    layer.hidden = true;
    DR.dom.qa('.modal', layer).forEach(function (m) { m.hidden = true; m.classList.remove('is-open'); });
    document.body.classList.remove('is-modal-open');
  }
  function currentModal() {
    var layer = document.getElementById('modal-layer');
    var open = layer ? layer.querySelector('.modal.is-open') : null;
    return open ? open.dataset.modal : null;
  }

  function packBadge(packId) {
    var p = DR.dict.PACK_BY_ID[packId];
    if (!p) return null;
    return h('span', { class: 'tag tag--' + packId, title: p.en }, p.zh);
  }

  DR.ui = { icon: icon, toast: toast, openModal: openModal, closeModal: closeModal, currentModal: currentModal, packBadge: packBadge };
})();
