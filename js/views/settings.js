/* 设置面板：外观 / 查词行为 / 数据导入导出 / 关于与快捷键。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});
  var h = function () { return DR.dom.h.apply(null, arguments); };
  var q = function (s, r) { return DR.dom.q(s, r); };
  var icon = function (n, s) { return DR.ui.icon(n, s); };
  var toast = function (m, o) { return DR.ui.toast(m, o); };

  var inited = false;
  var els = {};

  function init() {
    if (inited) return;
    inited = true;
    els.body = q('#settings-body');
    els.body.appendChild(build());
  }

  function field(label, control, hint) {
    var row = h('div', { class: 'set-row' },
      h('div', { class: 'set-row__label' }, h('span', {}, label), hint ? h('span', { class: 'set-row__hint' }, hint) : null),
      h('div', { class: 'set-row__control' }, control)
    );
    return row;
  }

  function build() {
    var s = DR.store.settings();
    var wrap = h('div', { class: 'settings' });

    /* 外观 */
    var themeSeg = h('div', { class: 'segmented', id: 'set-theme', role: 'group', 'aria-label': '主题' });
    [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].forEach(function (t) {
      themeSeg.appendChild(h('button', {
        type: 'button', class: 'segmented__btn' + (s.theme === t[0] ? ' is-active' : ''),
        dataset: { theme: t[0] },
        onclick: function () { setSetting('theme', t[0]); }
      }, t[1]));
    });
    var fontRange = h('input', {
      type: 'range', id: 'set-font', min: '0.85', max: '1.35', step: '0.05', value: String(s.fontScale),
      oninput: function () { setSetting('fontScale', Number(fontRange.value)); }
    });
    var fontSel = h('select', {
      id: 'set-readfont', 'aria-label': '阅读字体',
      onchange: function () { setSetting('readFont', fontSel.value); }
    },
      [
        ['newsreader', 'Newsreader · 默认阅读体'],
        ['literata', 'Literata · 阅读体'],
        ['mono', 'JetBrains Mono · 等宽连字'],
        ['sans', 'Inter · 无衬线'],
        ['system', '系统衬线（不加载字体）'],
        ['custom', '自定义…']
      ].map(function (o) {
        return h('option', { value: o[0], selected: s.readFont === o[0] ? true : null }, o[1]);
      })
    );
    var fontCtl = h('div', { class: 'font-ctl' },
      fontSel,
      s.readFont === 'custom' ? h('input', {
        id: 'set-customfont', type: 'text', value: s.customFont || '',
        placeholder: '本机字体名，如 Sitka Text',
        oninput: function (e) { setSetting('customFont', e.target.value); }
      }) : null
    );
    var sample = h('div', { class: 'font-sample' },
      h('p', { class: 'font-sample__display' }, '深读 DeepRead'),
      h('p', {}, 'The quick brown fox jumps over the lazy dog. 0123456789'),
      h('p', { class: 'font-sample__zh' }, '中文译文（霞鹜文楷）：把文章放进来，慢慢读。'),
      h('p', { class: 'font-sample__hint' }, '连字预览：fi fl ffi ffl · → ≠ ≤ ≥')
    );
    var lineRange = h('input', {
      type: 'range', id: 'set-line', min: '1.6', max: '2.2', step: '0.05', value: String(s.lineHeight),
      oninput: function () { setSetting('lineHeight', Number(lineRange.value)); }
    });
    var marksToggle = h('input', {
      type: 'checkbox', id: 'set-marks', checked: s.marks,
      onchange: function () { setSetting('marks', marksToggle.checked); }
    });
    var autoAddToggle = h('input', {
      type: 'checkbox', id: 'set-autoadd', checked: s.autoAdd,
      onchange: function () { setSetting('autoAdd', autoAddToggle.checked); }
    });

    var look = h('section', { class: 'set-group' },
      h('h3', { class: 'set-group__title' }, '外观'),
      field('主题', themeSeg),
      field('阅读字体', fontCtl, '标题固定 Fraunces；这里只换英文正文。等宽连字适合代码感排版，自定义可填本机字体名'),
      sample,
      field('阅读字号', h('div', { class: 'range-wrap' }, fontRange, h('output', { id: 'out-font' }, Math.round(s.fontScale * 100) + '%'))),
      field('行高', h('div', { class: 'range-wrap' }, lineRange, h('output', { id: 'out-line' }, s.lineHeight.toFixed(2)))),
      field('词级下划线', marksToggle, '按词所属的最低门槛词库着色（四级→六级→专四→专八），功能词与默认阅读不标；默认关闭')
    );

    var lookup = h('section', { class: 'set-group' },
      h('h3', { class: 'set-group__title' }, '查词'),
      field('自动收入生词本', autoAddToggle, '每查一个词就留下记录（含原句），方便之后复习'),
      h('p', { class: 'set-note' }, '关闭后仍可在单词卡里点「收入生词本」手动添加。')
    );

    var dataBox = h('section', { class: 'set-group' },
      h('h3', { class: 'set-group__title' }, '数据'),
      h('p', { class: 'set-note' }, '所有内容都存在这台电脑的浏览器里（文章元数据在 localStorage，电子书正文在 IndexedDB），不上传、不联网。换设备、换浏览器或清缓存会丢，建议偶尔「导出备份」——会把整本书和阅读进度一起打包成 .json，在新设备上「导入备份」即可接着读。'),
      h('div', { class: 'set-actions' },
        h('button', { class: 'btn', type: 'button', onclick: exportBackup }, icon('download', 15), '导出备份'),
        h('button', { class: 'btn', type: 'button', onclick: function () { q('#import-file').click(); } }, icon('upload', 15), '导入备份'),
        h('input', { type: 'file', id: 'import-file', accept: '.json,application/json', hidden: true, onchange: importBackup }),
        h('button', { class: 'btn btn--danger-ghost', type: 'button', onclick: clearNotebook }, '清空生词本'),
        h('button', { class: 'btn btn--danger-ghost', type: 'button', onclick: clearArticles }, '清空文章')
      )
    );

    var about = h('section', { class: 'set-group' },
      h('h3', { class: 'set-group__title' }, '关于'),
      h('p', { class: 'set-note' }, '深读 DeepRead · 一个只在本机运行的英语精读工具。词库来自 KyleBing/english-vocabulary（MIT）与 ECDICT（MIT）；站点代码原创。'),
      h('p', { class: 'set-note' }, h('a', { href: 'docs/CREDITS.md', target: '_blank', rel: 'noopener' }, '许可与素材来源（CREDITS.md）')),
      h('div', { class: 'set-kbd' },
        h('p', { class: 'eyebrow' }, '快捷键'),
        h('ul', {},
          kbdRow('Ctrl / ⌘ + K', '跳到词库搜索'),
          kbdRow('Alt / ⌥ + 点击', '直接看任意句子的成分'),
          kbdRow('空格', '复习时翻面'),
          kbdRow('1 / 2 / 3', '复习时评分：不认识 / 模糊 / 认识'),
          kbdRow('Esc', '关闭弹窗 / 取消选中')))
    );

    wrap.appendChild(look);
    wrap.appendChild(lookup);
    wrap.appendChild(dataBox);
    wrap.appendChild(about);
    return wrap;
  }

  function kbdRow(k, v) {
    return h('li', {}, h('span', { class: 'kbd' }, k), h('span', {}, v));
  }

  function setSetting(key, val) {
    var s = DR.store.settings();
    s[key] = val;
    DR.store.saveSettings(s);
    apply();
    // 更新面板内的状态
    if (key === 'theme') {
      DR.dom.qa('#set-theme .segmented__btn', document).forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.theme === val);
      });
    }
    if (key === 'readFont') {
      DR.dom.clear(els.body);
      els.body.appendChild(build());
    }
    if (key === 'fontScale') { var o = q('#out-font'); if (o) o.textContent = Math.round(val * 100) + '%'; }
    if (key === 'lineHeight') { var o2 = q('#out-line'); if (o2) o2.textContent = Number(val).toFixed(2); }
    if (key === 'marks' && DR.reader) DR.reader.refreshMarks();
  }

  function apply() {
    var s = DR.store.settings();
    var theme = s.theme;
    if (theme === 'auto' && window.matchMedia) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.readFont = s.readFont || 'newsreader';
    document.documentElement.style.removeProperty('--font-read');
    if (s.readFont === 'custom' && s.customFont) {
      document.documentElement.style.setProperty('--font-read',
        '"' + String(s.customFont).replace(/["\\]/g, '') + '", var(--font-serif-stack)');
    }
    document.documentElement.style.setProperty('--font-scale', String(s.fontScale || 1));
    document.documentElement.style.setProperty('--read-leading', String(s.lineHeight || 1.9));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0C1416' : '#F2F4F1');
    if (DR.app && DR.app.syncChrome) DR.app.syncChrome();
    if (DR.reader) DR.reader.refreshMarks();
  }

  function open() {
    init();
    DR.dom.clear(els.body);
    els.body.appendChild(build());
    apply();
    DR.ui.openModal('settings');
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function exportBackup() {
    if (!DR.backup) { toast('备份模块没加载（js/core/backup.js）', { kind: 'warn' }); return; }
    toast('正在打包，电子书正文也要一起拷…');
    DR.backup.build().then(function (bundle) {
      var r = DR.backup.download(bundle);
      toast('已导出 ' + r.name + ' · ' + fmtBytes(r.bytes) + ' · ' + r.stats.chapters + ' 章');
    }).catch(function (e) {
      toast('导出失败：' + (e && e.message ? e.message : e), { kind: 'warn' });
    });
  }

  function importBackup(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      var obj;
      try { obj = JSON.parse(String(fr.result)); }
      catch (err) { toast('不是有效的备份文件（JSON 解析失败）', { kind: 'warn' }); return; }
      DR.backup.importBundle(obj).then(function (r) {
        apply();
        DR.reader.renderLibrary();
        DR.reader.show();
        if (DR.notebook && DR.notebook.refreshIfVisible) DR.notebook.refreshIfVisible();
        DR.ui.closeModal();
        toast('已导入：' + r.articles + ' 篇 · ' + r.stats.chapters + ' 章' +
          (r.stats.notes ? ' · 生词 ' + r.stats.notes : ''));
      }).catch(function (err) {
        toast('导入失败：' + (err && err.message ? err.message : err), { kind: 'warn' });
      });
    };
    fr.readAsText(f, 'utf-8');
    e.target.value = '';
  }

  function clearNotebook() {
    if (!window.confirm('清空生词本？文章不会删除。')) return;
    DR.store.saveNotebook({ v: 1, order: [], items: {} });
    if (DR.reader) DR.reader.refreshBadges();
    if (DR.reader) DR.reader.refreshMarks();
    DR.notebook.refresh();
    DR.notebook.renderList();
    toast('生词本已清空');
  }

  function clearArticles() {
    if (!window.confirm('清空全部文章？生词本会保留。')) return;
    DR.store.saveArticles([]);
    DR.store.setActive('');
    DR.reader.renderWelcome();
    toast('文章已清空');
  }

  DR.settings = { init: init, open: open, apply: apply, build: build };
})();
