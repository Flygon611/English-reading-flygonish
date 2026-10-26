#!/usr/bin/env node
/* 复习题库自检（不启动浏览器）：题型、选项、混淆项、拼写、性能。
   用法：node tools/quiz-test.js
   退出码：0 全绿 / 1 有失败 */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function load(p) { require(path.join(ROOT, p)); }

global.window = global;
load('js/engine/text.js');
load('js/data/exam.js');
load('js/data/dict.js');
load('js/core/dict.js');
load('js/core/quiz.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push({ name, detail });
  console.log('✗ ' + name + (detail ? '  ' + detail : ''));
}
function checkUniqueOptions(q) {
  return new Set(q.options.map(o => o.text)).size === q.options.length;
}

const ctx = {
  deliberate: 'The committee, which had been deliberating for nearly six hours, finally reached a conclusion.',
  ubiquitous: 'Smartphones are ubiquitous, held aloft above the crowd.',
  notebook: 'I underlined difficult words, copied their definitions into a notebook.',
  committee: 'The committee met in private and reached a conclusion.',
  imminent: 'The storm was imminent, so we hurried home.',
  resilience: 'She showed great resilience after the setback.',
  were: 'It was a bright cold day, and the clocks were striking thirteen.'
};
const items = [];
Object.keys(ctx).forEach(function (w) {
  const e = window.DR.dict.lookup(w);
  if (!e) return;
  items.push({
    key: w, w: e.w, lemma: e.w, zh: e.zh, ipa: e.ipa || '', packs: e.packs || [],
    forms: e.forms || [], contexts: [{ text: ctx[w] }]
  });
});
ok(items.length >= 5, '测试词条准备', 'items=' + items.length);

/* 1. 各题型都能生成，选项合法 */
['mix', 'meaning', 'word', 'cloze', 'spell'].forEach(function (mode) {
  const qs = window.DR.quiz.build(items, mode);
  ok(qs.length === items.length, mode + '：每题都有题目', 'got=' + qs.length);
  qs.forEach(function (q, i) {
    ok(q && q.item, mode + ' 第 ' + i + ' 题有 item');
    if (q.type === 'flash') return;
    if (q.options) {
      const corrects = q.options.filter(o => o.correct);
      ok(corrects.length === 1, mode + ' 第 ' + i + ' 题恰好一个正确答案', JSON.stringify(q.options.map(o => o.text)));
      ok(q.options.length >= 3 && q.options.length <= 4, mode + ' 第 ' + i + ' 题选项数 3–4', 'n=' + q.options.length);
      ok(checkUniqueOptions(q), mode + ' 第 ' + i + ' 题选项不重复');
      ok(q.options.every(o => o.text && o.text.length <= 240), mode + ' 第 ' + i + ' 题选项文本合理');
    }
    if (q.type === 'cloze') ok(String(q.prompt).indexOf('____') >= 0, '语境填空题有空格', q.prompt);
    if (q.type === 'spell') {
      ok(q.accept && q.accept.length >= 1, '拼写题有可接受答案');
      ok(q.accept.indexOf(window.DR.quiz.defText(q.item.lemma || q.item.w, 0)) >= 0 || q.accept.indexOf(q.item.w.toLowerCase()) >= 0, '拼写题接受答案包含词头', JSON.stringify(q.accept));
    }
  });
});

/* 2. 混淆项：拼写相近、释义相近 */
const neigh = window.DR.quiz.spellingNeighbors('deliberate', 8);
ok(neigh.length >= 3, '拼写混淆项数量', 'n=' + neigh.length);
ok(neigh.some(e => /deliberat|liberate|delineate|deliberately/i.test(e.w)), '拼写混淆项包含形近词', neigh.map(e => e.w).join(','));
const meaning = window.DR.quiz.meaningNeighbors({ w: 'deliberate', lemma: 'deliberate', zh: 'v. 仔细考虑；思考；商议  adj. 故意的' }, 8);
ok(meaning.length >= 3, '释义混淆项数量', 'n=' + meaning.length);

/* 3. 同一轮混合同题型至少有 2 种（题型轮换） */
const mixed = window.DR.quiz.build(items, 'mix');
const types = new Set(mixed.map(q => q.type));
ok(types.size >= 2, '混合题型有 ≥2 种题型', Array.from(types).join(','));

/* 4. 性能：20 题构建（含首次索引） */
const many = [];
for (let i = 0; i < 20; i++) many.push(items[i % items.length]);
const t0 = Date.now();
window.DR.quiz.build(many, 'mix');
const ms = Date.now() - t0;
ok(ms < 1500, '混合 20 题构建耗时 < 1500ms', ms + 'ms');

console.log('\n复习题库自检：' + (pass + fail) + ' 项，' + pass + ' 通过，' + fail + ' 失败');
if (fail) { console.log(JSON.stringify(failures.slice(0, 20), null, 1)); process.exit(1); }
console.log('✓ 全部通过');
