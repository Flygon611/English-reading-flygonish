#!/usr/bin/env node
/* 本地静态服务器（开发用，禁用缓存，免装依赖）。
   用法：
     node tools/serve.js [port]
     node tools/serve.js 8801 --root dist --prefix /deepread/   # 模拟 GitHub Pages 子路径
   默认端口 8787，仅监听 127.0.0.1。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = Number(argv[0] && !argv[0].startsWith('--') ? argv[0] : 8787);
const DIR = path.resolve(ROOT, opt('root', '.'));

let PREFIX = opt('prefix', '');
if (PREFIX && PREFIX.charAt(0) !== '/') PREFIX = '/' + PREFIX;
PREFIX = PREFIX.replace(/\/+$/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
  catch (e) { res.writeHead(400); res.end('bad request'); return; }
  if (PREFIX) {
    if (pathname === PREFIX) { res.writeHead(302, { Location: PREFIX + '/' }); res.end(); return; }
    if (pathname.indexOf(PREFIX + '/') !== 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + pathname + '（前缀应为 ' + PREFIX + '/）');
      return;
    }
    pathname = pathname.slice(PREFIX.length);
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const file = path.join(DIR, pathname);
  if (!file.startsWith(DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('深读 DeepRead: http://127.0.0.1:' + PORT + (PREFIX || '') + '/');
  console.log('root: ' + DIR + (PREFIX ? '  prefix: ' + PREFIX : '') + '  (Ctrl+C 停止)');
});
