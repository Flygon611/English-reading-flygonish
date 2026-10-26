#!/usr/bin/env node
/* 电子书解析自检（Node 端，不需要浏览器）
 *
 * 用法：node tools/test-ebook.js [额外 .epub/.txt 路径...]
 * 不带参数时只跑内置的纯文本用例；带 EPUB 路径则顺带解析并打印章节统计。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ctx = { window: {}, TextDecoder, DecompressionStream, Blob, Response, Promise, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'core', 'ebook.js'), 'utf8'), ctx);
const ebook = ctx.window.DR.ebook;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/* ---------- 1. 纯文本分章 ---------- */
console.log('\n[1] txt 分章');
const txt = [
  'Pride and Prejudice',
  'by Jane Austen',
  '',
  'CHAPTER I',
  '',
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
  '',
  'CHAPTER II',
  '',
  'Mr. Bennet was among the earliest of those who waited on Mr. Bingley.',
  '',
  'CHAPTER III',
  '',
  'Not all that Mrs. Bennet, however, with the assistance of her five daughters, could ask on the subject.',
].join('\n');
const t1 = ebook.parseText(txt);
check('识别作者 by Jane Austen', t1.author === 'Jane Austen', t1.author);
check('识别 3 章', t1.chapters.length === 3, 'chapters=' + t1.chapters.length);
check('章标题保留 CHAPTER I', /^CHAPTER I$/.test(t1.chapters[0].title), t1.chapters[0].title);
check('章正文不含标题', t1.chapters[0].text.indexOf('CHAPTER I') < 0);

const cnTxt = ['三体', '第一章 科学边界', '汪淼觉得，来找他的这四个人是一个奇怪的组合。', '', '第二章 台球', '丁仪把球杆递给汪淼。'].join('\n');
const t2 = ebook.parseText(cnTxt);
check('中文「第X章」分章', t2.chapters.length === 2, 'chapters=' + t2.chapters.length);

const noChap = 'A short note.\n\nJust two paragraphs, no chapter headings at all.';
const t3 = ebook.parseText(noChap);
check('无章节时退回单章', t3.chapters.length === 1 && t3.chapters[0].text.indexOf('short note') >= 0);

const big = [];
for (let i = 0; i < 900; i++) big.push('Paragraph number ' + i + ' with some words to make it longer than a few characters.');
const t4 = ebook.parseText(big.join('\n\n'));
check('超长无章节文本自动分段', t4.chapters.length > 1, 'chapters=' + t4.chapters.length);

/* ---------- 2. 外部 EPUB ---------- */
const files = process.argv.slice(2);
(async () => {
  for (const f of files) {
    console.log('\n[2] EPUB: ' + path.basename(f));
    const buf = fs.readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const t0 = Date.now();
    const book = await ebook.parseEpub(ab);
    const ms = Date.now() - t0;
    const words = book.chapters.reduce((a, c) => a + (c.text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length, 0);
    console.log('  title  :', JSON.stringify(book.title));
    console.log('  author :', JSON.stringify(book.author));
    console.log('  chapters:', book.chapters.length, '| words', words, '|', ms + 'ms');
    console.log('  首章:', JSON.stringify((book.chapters[0].title || '').slice(0, 40)), '|', (book.chapters[0].text || '').slice(0, 60).replace(/\n/g, ' '));
    const last = book.chapters[book.chapters.length - 1];
    console.log('  末章:', JSON.stringify((last.title || '').slice(0, 40)), '|', (last.text || '').slice(0, 60).replace(/\n/g, ' '));
    const empty = book.chapters.filter((c) => !c.text.trim()).length;
    const tiny = book.chapters.filter((c) => c.text.trim().length < 200).length;
    console.log('  空章', empty, '| <200 字符的章', tiny);
    check(path.basename(f) + ' 解析出章节', book.chapters.length >= 5, 'chapters=' + book.chapters.length);
    check(path.basename(f) + ' 有作者', !!book.author, book.author);
    check(path.basename(f) + ' 有书名', !!book.title, book.title);
    check(path.basename(f) + ' 无空章', empty === 0, 'empty=' + empty);
  }

  console.log('\n' + (pass + fail) + ' 项，' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
