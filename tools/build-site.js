#!/usr/bin/env node
/* 打包出可直接上传 GitHub Pages 的静态站（dist/）。
 *
 * 只放运行站点需要的东西：
 *   index.html / css / js（含词库数据）/ assets/fonts（含 OFL 许可证）/ LICENSE / CREDITS.md / README.md
 * 不放：tools/（构建脚本）、preview/（截图，里面可能含受版权保护的正文片段）、docs/、CONTRACT.md
 *
 * 用法：node tools/build-site.js [--out dist]
 * 产物可直接 `git push` 到仓库，或用 .github/workflows/pages.yml 自动部署。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = path.resolve(ROOT, outArg >= 0 ? (argv[outArg + 1] || 'dist') : 'dist');

const COPY_FILES = ['index.html', 'LICENSE', 'README.md'];
const COPY_DIRS = ['css', 'js', 'assets/fonts'];
const RENAME = { 'docs/CREDITS.md': 'CREDITS.md' };

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

function copyDir(from, to, stats) {
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) copyDir(src, dst, stats);
    else {
      const size = copyFile(src, dst);
      stats.bytes += size;
      stats.files += 1;
      const rel = path.relative(OUT, dst).split(path.sep).join('/');
      if (/\.(js|css|woff2?|ttf|html)$/.test(rel)) stats.breakdown[rel.split('/')[0] + '/'] = (stats.breakdown[rel.split('/')[0] + '/'] || 0) + size;
    }
  }
}

function main() {
  rmrf(OUT);
  const stats = { files: 0, bytes: 0, breakdown: {} };
  const t0 = Date.now();

  for (const f of COPY_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) { console.warn('跳过（不存在）：' + f); continue; }
    stats.bytes += copyFile(src, path.join(OUT, f));
    stats.files += 1;
  }
  for (const d of COPY_DIRS) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) throw new Error('缺少目录：' + d);
    copyDir(src, path.join(OUT, d), stats);
  }
  for (const [from, to] of Object.entries(RENAME)) {
    const src = path.join(ROOT, from);
    if (!fs.existsSync(src)) continue;
    stats.bytes += copyFile(src, path.join(OUT, to));
    stats.files += 1;
    // 站内「许可与素材来源」链接指向 docs/CREDITS.md，这里同时保留一份
    stats.bytes += copyFile(src, path.join(OUT, 'docs', path.basename(from)));
    stats.files += 1;
  }

  /* .nojekyll：让 GitHub Pages 原样发布（不做 Jekyll 处理） */
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  /* 自检：index.html 里引用的本地资源都得在 dist 里 */
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  const missing = [];
  const re = /(?:src|href)="([^"#:]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1];
    if (/^(data:|mailto:|https?:|\/\/)/.test(ref)) continue;
    if (!fs.existsSync(path.join(OUT, ref))) missing.push(ref);
  }
  if (missing.length) {
    console.error('❌ dist 里缺少 index.html 引用的文件：\n  ' + missing.join('\n  '));
    process.exit(1);
  }

  /* 自检 2：Linux 上的 GitHub Pages 区分大小写，检查所有本地引用的大小写是否与文件名一致 */
  const actual = new Map();
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else actual.set(path.relative(OUT, p).split(path.sep).join('/'), true);
    }
  })(OUT);
  const caseProblems = [];
  const refRe = /(?:url\(['"]?|src=["']|href=["'])([^"'()\s#:]+\.(?:woff2?|ttf|otf|css|js|png|svg|md))/g;
  const filesToScan = [];
  (function collect(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) collect(p);
      else if (/\.(css|js|html)$/.test(name)) filesToScan.push(p);
    }
  })(OUT);
  for (const file of filesToScan) {
    const text = fs.readFileSync(file, 'utf8');
    const baseDir = path.dirname(path.relative(OUT, file)).split(path.sep).join('/');
    let mm;
    refRe.lastIndex = 0;
    while ((mm = refRe.exec(text))) {
      const ref = mm[1];
      if (/^(data:|https?:|\/\/)/.test(ref)) continue;
      const rel = ref.charAt(0) === '/' ? ref.slice(1) : path.posix.normalize((baseDir ? baseDir + '/' : '') + ref);
      if (!actual.has(rel)) {
        const lower = ref.toLowerCase();
        const near = [...actual.keys()].find((k) => k.toLowerCase() === rel.toLowerCase());
        caseProblems.push(near ? ('大小写不一致：' + ref + ' → 实际 ' + near) : ('找不到：' + ref + '（引用自 ' + path.relative(OUT, file) + '）'));
      }
    }
  }
  if (caseProblems.length) {
    console.error('❌ GitHub Pages（Linux，区分大小写）会 404：\n  ' + [...new Set(caseProblems)].join('\n  '));
    process.exit(1);
  }

  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log('✓ 静态站已生成：' + OUT);
  console.log('  文件 ' + stats.files + ' 个 · 合计 ' + mb(stats.bytes) + ' · 用时 ' + (Date.now() - t0) + 'ms');
  Object.entries(stats.breakdown)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('  ' + k.padEnd(12) + mb(v)));
  console.log('\n下一步：把 ' + path.relative(ROOT, OUT) + '/ 推上 GitHub，仓库 Settings → Pages 选 GitHub Actions（或用仓库自带的 .github/workflows/pages.yml）。');
}

main();
