/* 电子书解析：EPUB（zip + OPF + NCX/NAV）与纯文本（txt/md）。
   不依赖任何第三方库：
     - zip 解包用浏览器/Node 都有的 DecompressionStream('deflate-raw')（Chromium 103+ / Node 18+）
     - 元数据读 container.xml → OPF 的 dc:title / dc:creator
     - 章节优先按 NCX / nav.xhtml 的目录切，目录缺失时退化成「一个 spine 文件一章」
   输出统一为：
     { title, author, language, chapters:[{ title, book, text }], source, bytes }
   纯解析，不碰 DOM、不碰存储，可在 Node 里直接跑测试。 */
(function () {
  'use strict';
  var DR = (window.DR = window.DR || {});

  /* ---------------- 通用小工具 ---------------- */

  function decodeUtf8(buf) {
    return new TextDecoder('utf-8').decode(buf);
  }

  function inflateRaw(bytes) {
    // DecompressionStream 在 Chromium 103+ 与 Node 18+ 都有；file:// 下同样可用
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', shy: '' };

  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var n = body.charAt(1).toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '';
      }
      var v = ENTITIES[body.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function htmlToText(html) {
    var s = String(html || '');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|svg|head)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n\n');
    s = s.replace(/<(p|div|h[1-6]|li|tr|blockquote)\b[^>]*>/gi, '\n\n');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/[ \t\u00a0]+/g, ' ');
    s = s.replace(/ *\n */g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  /* ---------------- ZIP ---------------- */

  function findEocd(view, bytes) {
    var min = Math.max(0, bytes.length - 0xFFFF - 22);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  function readZip(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var view = new DataView(arrayBuffer);
    var eocd = findEocd(view, bytes);
    if (eocd < 0) throw new Error('不是有效的 zip/epub：找不到中央目录');
    var count = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    var entries = Object.create(null);
    var order = [];
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var flags = view.getUint16(p + 8, true);
      var method = view.getUint16(p + 10, true);
      var csize = view.getUint32(p + 20, true);
      var usize = view.getUint32(p + 24, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var cmtLen = view.getUint16(p + 32, true);
      var lho = view.getUint32(p + 42, true);
      var name = decodeUtf8(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + cmtLen;
      if (name.charAt(name.length - 1) === '/') continue;   // 目录项
      entries[name] = { name: name, method: method, flags: flags, csize: csize, usize: usize, lho: lho };
      order.push(name);
    }
    function dataOffset(e) {
      var lnameLen = view.getUint16(e.lho + 26, true);
      var lextraLen = view.getUint16(e.lho + 28, true);
      return e.lho + 30 + lnameLen + lextraLen;
    }
    function readRaw(e) {
      var start = dataOffset(e);
      return bytes.subarray(start, start + e.csize);
    }
    function readText(e) {
      var raw = readRaw(e);
      if (e.method === 0) return Promise.resolve(decodeUtf8(raw));
      if (e.method === 8) return inflateRaw(raw).then(decodeUtf8);
      return Promise.reject(new Error('不支持的压缩方式：' + e.method + '（' + e.name + '）'));
    }
    return { entries: entries, order: order, readText: readText };
  }

  /* ---------------- XML / 路径小工具 ---------------- */

  function attr(tag, name) {
    var m = String(tag).match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']'));
    return m ? decodeEntities(m[1]) : '';
  }

  function resolvePath(base, href) {
    // base 是所在文件的目录，href 可能含 ../ 或 /前缀
    var b = base.split('/');
    b.pop();
    var parts = String(href || '').replace(/^\.\//, '').split('/');
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') b.pop();
      else b.push(seg);
    }
    return b.join('/');
  }

  function stripFragment(p) { return String(p || '').split('#')[0]; }
  function fragmentOf(p) { var i = String(p || '').indexOf('#'); return i < 0 ? '' : String(p).slice(i + 1); }

  /* ---------------- EPUB ---------------- */

  function parseEpub(arrayBuffer, opts) {
    var opts2 = opts || {};
    var zip = readZip(arrayBuffer);
    return zip.readText(zip.entries['META-INF/container.xml'])
      .then(function (containerXml) {
        var rootTag = (containerXml.match(/<rootfile\b[^>]*>/i) || [''])[0];
        var opfPath = attr(rootTag, 'full-path') ||
          ((containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i) || [])[1] || '');
        if (!opfPath) {
          var guess = zip.order.filter(function (n) { return /\.opf$/i.test(n); })[0];
          if (!guess) throw new Error('EPUB 里没有 .opf 文件');
          opfPath = guess;
        }
        var opfEntry = zip.entries[opfPath];
        if (!opfEntry) {
          // 有些 EPUB 的 container.xml 写错路径，退回按文件名找
          var alt = zip.order.filter(function (n) { return /\.opf$/i.test(n); })[0];
          if (!alt) throw new Error('找不到 OPF：' + opfPath);
          opfEntry = zip.entries[alt];
          opfPath = alt;
        }
        return zip.readText(opfEntry).then(function (opf) {
          return parseOpf(zip, opfPath, opf, opts2);
        });
      });
  }

  function parseOpf(zip, opfPath, opf, opts) {
    var meta = {
      title: decodeEntities(((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '').trim()),
      author: decodeEntities(((opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '').trim()),
      language: ((opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i) || [])[1] || '').trim()
    };
    var manifest = Object.create(null);
    var itemRe = /<item\b[^>]*>/gi;
    var m;
    while ((m = itemRe.exec(opf))) {
      var tag = m[0];
      var id = attr(tag, 'id');
      var href = attr(tag, 'href');
      if (!id || !href) continue;
      manifest[id] = {
        id: id, href: resolvePath(opfPath, href), mediaType: attr(tag, 'media-type'),
        properties: attr(tag, 'properties')
      };
    }
    var spine = [];
    var refRe = /<itemref\b[^>]*>/gi;
    while ((m = refRe.exec(opf))) {
      var idref = attr(m[0], 'idref');
      if (idref && manifest[idref]) spine.push(manifest[idref]);
    }
    if (!spine.length) {
      // 没有 spine：把 manifest 里的 html 按文件名顺序当正文
      Object.keys(manifest).forEach(function (k) {
        var it = manifest[k];
        if (/xhtml|html/i.test(it.mediaType) || /\.x?html?$/i.test(it.href)) spine.push(it);
      });
      spine.sort(function (a, b) { return a.href < b.href ? -1 : a.href > b.href ? 1 : 0; });
    }

    // 目录：优先 EPUB3 nav，其次 NCX
    var navEntry = null;
    Object.keys(manifest).forEach(function (k) {
      var it = manifest[k];
      if (/nav/.test(it.properties || '')) navEntry = it;
    });
    var ncxId = (opf.match(/<spine\b[^>]*\btoc\s*=\s*["']([^"']+)["']/i) || [])[1];
    var ncxEntry = ncxId && manifest[ncxId] ? manifest[ncxId] : null;
    if (!ncxEntry) {
      Object.keys(manifest).forEach(function (k) {
        if (/\.ncx$/i.test(manifest[k].href)) ncxEntry = manifest[k];
      });
    }

    var tocPromise = Promise.resolve(null);
    if (navEntry) {
      tocPromise = zip.readText(zip.entries[navEntry.href]).then(function (html) {
        return parseNav(html, navEntry.href);
      }).catch(function () { return null; });
    } else if (ncxEntry) {
      tocPromise = zip.readText(zip.entries[ncxEntry.href]).then(function (xml) {
        return parseNcx(xml, ncxEntry.href);
      }).catch(function () { return null; });
    }

    return tocPromise.then(function (toc) {
      var tasks = spine.map(function (item) {
        var entry = zip.entries[item.href];
        if (!entry) return Promise.resolve(null);
        return zip.readText(entry).then(function (raw) {
          return { item: item, raw: raw };
        }).catch(function () { return null; });
      });
      return Promise.all(tasks).then(function (docs) {
        return assemble(meta, docs, toc, opts);
      });
    });
  }

  /* 目录解析成 [{label, href, depth, book}]，depth=1 是「书/部」，depth≥2 是章 */
  function parseNcx(xml, base) {
    var out = [];
    var stack = [];
    var tagRe = /<\/?([a-zA-Z:]+)[^>]*>/g;
    var m;
    var textStart = -1;
    while ((m = tagRe.exec(xml))) {
      var tag = m[0];
      var name = m[1].toLowerCase();
      var closing = tag.charAt(1) === '/';
      if (name === 'navpoint') {
        if (closing) {
          var node = stack.pop();
          if (node && node.label) {
            out.push({
              label: node.label,
              href: node.href ? resolvePath(base, node.href) : '',
              depth: stack.length + 1,
              book: (stack[0] && stack[0].label) || ''
            });
          }
        } else if (tag.slice(-2) !== '/>') {
          stack.push({ label: '', href: '' });
        }
      } else if (name === 'text') {
        if (closing) {
          if (stack.length && textStart >= 0) {
            stack[stack.length - 1].label = decodeEntities(xml.slice(textStart, m.index)).replace(/\s+/g, ' ').trim();
          }
          textStart = -1;
        } else {
          textStart = tagRe.lastIndex;
        }
      } else if (name === 'content' && stack.length) {
        stack[stack.length - 1].href = attr(tag, 'src') || stack[stack.length - 1].href;
      }
    }
    return out;
  }

  function parseNav(html, base) {
    var out = [];
    var depth = 0;
    var pendingLabel = '';
    var tagRe = /<(\/?)ol\b[^>]*>|<(\/?)a\b([^>]*)>|[\s\S]*?(?=<)/gi;
    // 简化：先按 <ol>/</ol> 记层级，再按 <a href> 取标题
    var re = /<(\/?)ol\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      if (m[0].slice(0, 3).toLowerCase() === '<ol' || m[0].slice(0, 4).toLowerCase() === '</ol') {
        depth += m[0].charAt(1) === '/' ? -1 : 1;
        if (depth < 0) depth = 0;
        continue;
      }
      var href = attr(m[2] || '', 'href');
      var label = htmlToText(m[3] || '').replace(/\s+/g, ' ').trim();
      if (!href || !label) continue;
      out.push({ label: label, href: resolvePath(base, href), depth: depth, book: '' });
    }
    // 用层级补 book：深度 1 的标题作为后续深 2 项的书名
    var book = '';
    out.forEach(function (t) {
      if (t.depth <= 1) book = t.label;
      else t.book = book;
    });
    return out;
  }

  /* 正文清洗：去掉页眉页脚、目录点线、纯数字页码、两端对齐留下的多余空格 */
  function cleanBody(text, meta) {
    var dropNames = [];
    if (meta && meta.title) dropNames.push(meta.title.toLowerCase());
    if (meta && meta.author) dropNames.push(meta.author.toLowerCase());
    var out = [];
    String(text || '').split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t) { out.push(''); return; }
      var low = t.toLowerCase();
      if (dropNames.indexOf(low) >= 0) return;                       // 页眉：书名 / 作者
      if (/^[0-9]{1,4}$/.test(t)) return;                             // 页码
      if (!/[A-Za-z\u4e00-\u9fff0-9]/.test(t)) return;                // 纯符号 / 孤立项目符号
      if (/^[•·\-–—\s]*(([IVXLC]+|[0-9]+)\s*[•·\-–—]?\s*)+$/.test(t)) return;   // 章首导航 • I • II
      if (/\.{6,}/.test(t) && /(\.{2,}\s*\d+\s*$)|(^\S.*\.\.\.\s)/.test(t)) return;  // 目录点线
      out.push(t.replace(/[ \t]{2,}/g, ' '));
    });
    var joined = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // 目录页：大量「…」或大量 · 分隔
    if (joined.length < 4000 && (joined.match(/\.{4,}/g) || []).length > 5) return '';
    return joined;
  }

  function isTocLabel(label) {
    return /^(table of contents|contents|目录|目\s*录)\s*$/i.test(String(label || '').trim());
  }

  function normTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  }

  /* 把 spine 文档 + 目录拼成章节 */
  function assemble(meta, docs, toc, opts) {
    var SKIP = /(^|\/)(cover|copyright|titlepage|title|colophon|toc|nav|contents|dedication|alsoby|pottermore|acknowledg|advert|backmatter)[^/]*$/i;
    var FRONT = /^(cover|title page|copyright|contents|table of contents|dedication|pottermore(\.com)?|also by|acknowledg\w*|newsletter|the pottermore shop|about the author|praise|contents page)\b/i;
    var chapters = [];

    // 按「文件 + 锚点」切：目录里有锚点就切，否则整个文件一章
    var byFile = Object.create(null);
    (toc || []).forEach(function (t) {
      var f = stripFragment(t.href);
      (byFile[f] = byFile[f] || []).push(t);
    });

    var lastBook = '';
    docs.forEach(function (doc) {
      if (!doc) return;
      var href = doc.item.href;
      var raw = doc.raw;
      var text = cleanBody(htmlToText(raw), meta);
      if (!text) return;
      var heading = (raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || raw.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1];
      var headingText = heading ? htmlToText(heading).replace(/\s+/g, ' ').trim() : '';

      var marks = byFile[href];
      if (marks && marks.length > 1) {
        // 同一文件里多个目录项：按锚点位置切；同一锚点上的「书级」条目让位给章级条目
        var positions = marks.map(function (t) {
          var frag = fragmentOf(t.href);
          var idx = frag ? findAnchor(raw, frag) : 0;
          return { label: t.label, book: t.book || lastBook, depth: t.depth || 1, idx: idx < 0 ? 0 : idx };
        }).sort(function (a, b) { return a.idx - b.idx || b.depth - a.depth; });
        var dedup = [];
        positions.forEach(function (p) {
          var prev = dedup[dedup.length - 1];
          if (prev && prev.idx === p.idx) return;   // 同一锚点：保留先到的（排序时深的在前）
          dedup.push(p);
        });
        positions = dedup;
        for (var i = 0; i < positions.length; i++) {
          if (isTocLabel(positions[i].label) || FRONT.test(positions[i].label)) continue;
          if (positions[i].book) lastBook = positions[i].book;
          var start = positions[i].idx;
          var end = i + 1 < positions.length ? positions[i + 1].idx : raw.length;
          var piece = cleanBody(htmlToText(raw.slice(start, end)), meta);
          if (!piece) continue;
          chapters.push({ title: positions[i].label, book: positions[i].book, text: piece });
        }
        return;
      }

      var mark = marks && marks[0];
      var title = (mark && mark.label) || headingText || '';
      if (mark && mark.book) lastBook = mark.book;
      if (isTocLabel(title) || FRONT.test(title)) return;
      // 书级条目指向书内首页时，别把它当一章
      if (mark && mark.book && normTitle(title) === normTitle(mark.book)) return;
      if (!title && SKIP.test(href)) return;
      if (text.length < 120) return;                 // 版权页、封面之类
      if (SKIP.test(href) && text.length < 2000) return;
      chapters.push({ title: title, book: (mark && mark.book) || lastBook, text: text });
    });

    var body = chapters.filter(function (c) { return c.text && c.text.length >= 80; });
    if (!body.length) throw new Error('EPUB 里没有提取到正文');
    // 合订本常见「目录里另存了一份下一本的首页」：同标题 + 同正文只留最后一处（那才是它真正的书）
    var seen = Object.create(null);
    var deduped = [];
    for (var i = body.length - 1; i >= 0; i--) {
      var c = body[i];
      var key = normTitle(c.title) + '|' + c.text.slice(0, 160);
      if (seen[key]) continue;
      seen[key] = true;
      deduped.unshift(c);
    }
    body = deduped;
    // 章前散页只留「书」信息：如果一本书第一项没有章名，用它当书名的补充
    if (opts && opts.maxChapters && body.length > opts.maxChapters) body = body.slice(0, opts.maxChapters);
    return {
      title: meta.title || '', author: meta.author || '', language: meta.language || '',
      chapters: body, source: 'epub'
    };
  }

  function findAnchor(raw, frag) {
    var esc = frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('(id|name)\\s*=\\s*["\']' + esc + '["\']', 'i');
    var m = re.exec(raw);
    if (!m) return -1;
    // 回到标签开头
    var i = raw.lastIndexOf('<', m.index);
    return i < 0 ? m.index : i;
  }

  /* ---------------- 纯文本 ---------------- */

  var CN_NUM = '[一二三四五六七八九十百零〇两0-9]+';
  var CHAPTER_RES = [
    new RegExp('^\\s*(?:chapter|chap\\.?)\\s+([0-9]+|[ivxlcdm]+|[a-z]+)\\b[^\\n]{0,80}$', 'i'),
    new RegExp('^\\s*(?:part|book)\\s+([0-9]+|[ivxlcdm]+|[a-z]+)\\b[^\\n]{0,80}$', 'i'),
    new RegExp('^\\s*第\\s*' + CN_NUM + '\\s*[章回节卷篇部][^\\n]{0,60}$'),
    new RegExp('^\\s*(?:序章|楔子|尾声|后记|前言|序言|引子)\\s*$')
  ];

  function isChapterHeading(line) {
    var t = String(line || '').trim();
    if (!t || t.length > 90) return false;
    for (var i = 0; i < CHAPTER_RES.length; i++) if (CHAPTER_RES[i].test(t)) return true;
    return false;
  }

  function guessAuthorFromLines(lines) {
    for (var i = 0; i < Math.min(lines.length, 24); i++) {
      var t = lines[i].trim();
      var m = t.match(/^(?:by|author|written by|作者|著)\s*[：:]?\s*(.{2,40})$/i);
      if (m) return m[1].trim();
      if (/^author\s*[:：]/i.test(t)) return t.split(/[:：]/)[1].trim();
    }
    return '';
  }

  function parseText(text, opts) {
    var opts2 = opts || {};
    var raw = String(text || '').replace(/\r\n?/g, '\n');
    var lines = raw.split('\n');
    var author = opts2.author || guessAuthorFromLines(lines);
    var title = opts2.title || '';
    var chapterStart = -1;
    for (var i = 0; i < lines.length; i++) {
      if (isChapterHeading(lines[i])) { chapterStart = i; break; }
    }
    var chapters = [];
    if (chapterStart > 0 && chapterStart < 400) {
      var pre = lines.slice(0, chapterStart).join('\n').trim();
      var heads = [];
      for (var j = chapterStart; j < lines.length; j++) {
        if (isChapterHeading(lines[j])) heads.push(j);
      }
      heads.forEach(function (h, k) {
        var end = k + 1 < heads.length ? heads[k + 1] : lines.length;
        var bodyText = lines.slice(h + 1, end).join('\n').trim();
        if (!bodyText) return;
        chapters.push({ title: lines[h].trim(), book: '', text: bodyText });
      });
      if (chapters.length && pre) chapters[0].preface = pre;   // 章前内容（书名页/前言）
    }
    if (!chapters.length) {
      // 没有章标题：如果整篇很长，按空行块切，每块约 1 万字符
      var trimmed = raw.trim();
      if (trimmed.length > 30000) {
        var blocks = trimmed.split(/\n{2,}/);
        var buf = [], len = 0, n = 1;
        blocks.forEach(function (b) {
          buf.push(b); len += b.length + 2;
          if (len > 12000) {
            chapters.push({ title: '第 ' + n + ' 段', book: '', text: buf.join('\n\n') });
            n++; buf = []; len = 0;
          }
        });
        if (buf.length) chapters.push({ title: '第 ' + n + ' 段', book: '', text: buf.join('\n\n') });
      } else {
        chapters = [{ title: title || '正文', book: '', text: trimmed }];
      }
    }
    if (!chapters.length) throw new Error('没有提取到正文');
    return {
      title: title || '', author: author, language: '', chapters: chapters, source: opts2.source || 'txt'
    };
  }

  /* ---------------- 入口 ---------------- */

  function parseFile(file) {
    var name = String(file && file.name || '').toLowerCase();
    if (/\.epub$/.test(name) || file.type === 'application/epub+zip') {
      return file.arrayBuffer().then(function (buf) { return parseEpub(buf); });
    }
    if (/\.(txt|md|markdown|text)$/.test(name) || /^text\//.test(file.type || '')) {
      return file.text().then(function (t) { return parseText(t, { title: file.name.replace(/\.[^.]+$/, '') }); });
    }
    return Promise.reject(new Error('暂不支持这个格式：' + (file.name || '')));
  }

  DR.ebook = {
    parseFile: parseFile,
    parseEpub: parseEpub,
    parseText: parseText,
    htmlToText: htmlToText,
    readZip: readZip,
    isChapterHeading: isChapterHeading
  };
})();
