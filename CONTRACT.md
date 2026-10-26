# 深读 DeepRead · 契约与接口规范 v1

> **本文件是团队唯一权威接口契约。** 所有成员开工前完整阅读；与本文件冲突的实现以本文件为准。
> 需要改契约：向 Lead 发消息说明理由，由 Lead 统一修订，不得私自变更其他人依赖的字段。

---

## 0. 项目目标与优先级

一个**给人用的英语精读工具网站**：把文章（复制 / 粘贴 / .txt）放进来，逐词可点查本地词库，
查过的词自动进「生词本」，之后可以复习；另附启发式的句子成分分析。

优先级（不可动摇）：

1. **P0 查词**：点任意英文单词 → 音标、中文释义、词级（四级/六级/专四/专八）、例句、发音。
2. **P0 生词本 TAB**：所有查过的词自动保存（含原文例句），有独立页面，可筛选/搜索/标记/复习
   （闪卡 + 间隔重复 + 看义选词自测）。
3. **P1 文章**：粘贴/导入/保存/切换文章，阅读进度与设置本地保存。
4. **P2 句子成分分析**：点击句子 → 主谓宾/表语/状语/定语、从句、被动语态、非谓语、时态等标注。
   **规则启发式，允许出错**，UI 必须明示「自动推断，仅供参考」，不能假装百分百准确。
5. P3 词库搜索页（全库查词）、词根词缀提示。

反例（不要做）：故事/角色/宝可梦世界观、剧情叙事、备考模拟卷、练习题、语法课程库。
本站是**工具**，不是又一个学习游戏。

## 1. 技术约束（硬性）

| 项 | 规定 |
|---|---|
| 构建 | **无**。不使用 npm 依赖、打包器、框架、TS。手写 HTML/CSS/JS |
| 运行 | 纯静态。**双击 index.html（file://）必须可用**；也支持 `python -m http.server` |
| 脚本 | 经典 `<script>` + `window.*` 全局变量（file:// 下禁止 fetch/ES module） |
| 存储 | localStorage，键前缀 `dr.`；不上传任何数据 |
| 编码 | 全部 UTF-8 无 BOM，LF；中文界面 |
| 浏览器 | Edge / Chrome 近两年版本；不要求 Firefox/Safari 完美 |
| 数据 | 运行期不得联网；所有词库随站点分发 |
| 素材 | 允许自托管 SIL OFL 字体（用户明确要求，见 `css/fonts.css`）；不新增图片素材，图标用内联 SVG |

## 2. 目录与文件所有权（写作用域）

```
D:\ToolsSoftware\DeepReadEnglish\
├─ index.html                     Lead
├─ CONTRACT.md                    Lead
├─ README.md                      Lead
├─ css/tokens.css  app.css  reader.css  notebook.css   Lead
├─ js/core/dom.js store.js tts.js dict.js ui.js router.js  Lead
├─ js/engine/text.js              Lead（已冻结，见 §4.1）
├─ js/engine/pos.js analyze.js    parser-engine
├─ js/views/*.js                  Lead
├─ js/app.js                      Lead
├─ js/data/exam.js                lex-builder
├─ js/data/dict.js                lex-builder
├─ js/data/affixes.js             lex-builder
├─ js/data/pos-lex.js             parser-engine
├─ tools/build-dict.js            lex-builder
├─ tools/report-dict.js           lex-builder
├─ tools/build-pos.js             parser-engine
├─ tools/test-analyze.js          parser-engine
├─ tools/gold-sentences.json      parser-engine
├─ tools/browser-check.js         qa-verify
├─ tools/ui-test.js               qa-verify
├─ tools/serve.js                 Lead
├─ preview/                       qa-verify（截图产物）
├─ docs/DICT.md                   lex-builder
├─ docs/ANALYSIS.md               parser-engine
├─ docs/QA.md                     qa-verify
└─ docs/CREDITS.md                Lead
```

**只写自己作用域内的文件。** 需要别人文件改动 → 发消息给 Lead。
所有生成物（`js/data/*.js`）必须可由 `tools/*.js` 重新生成，脚本头部注明数据来源与许可。

## 3. 数据契约（lex-builder 产出）

数据源（只读，不要修改）：

- `D:\ToolsSoftware\DSH_learninguse\assets\vocab\{cet4,cet6,tem4,tem8,ielts,toefl}.json.gz`
  结构：`{ id, name, words: [ { w, p, t, d:[释义...], x:例句, xm:例句中译, lvl } ] }`
- `D:\ToolsSoftware\DSH_learninguse\tools\cache\vocab_raw\ecdict.csv`（66 MB，770,611 行；
  字段 `word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio`；
  注意：CSV 内换行是**字面 `\n` 两字符**；translation 里的 `[网络]`/`[医]` 等领域行大量错挂，
  参考 `D:\ToolsSoftware\DSH_learninguse\tools\ecdict_clean.py` 的诊断与清理思路，**必须清掉领域行**）
- `D:\ToolsSoftware\DSH_learninguse\assets\dict\affixes.json.gz`（前后缀/词根，中文释义）
- ECDICT `exchange` 字段格式：`p:过去式/d:过去分词/i:现在分词/3:三单/r:比较级/t:最高级/s:复数/0:原形/1:...`

### 3.1 `js/data/exam.js`

```js
window.DR_EXAM = {
  v: 1,
  packs: { cet4:'四级', cet6:'六级', tem4:'专四', tem8:'专八', ielts:'雅思', toefl:'托福' },
  words: [ [word, ipa, zh, ex, exZh, mask, lvl, forms], ... ]
};
```

| 字段 | 类型 | 要求 |
|---|---|---|
| word | string | 原形词头（小写优先；专有名词可保留大写）；忽略大小写后唯一 |
| ipa | string | 不带斜杠，如 `əˈbrʌptli`；可为 `''` |
| zh | string | 中文释义，保留 `n.`/`vt.` 等词性前缀；多义项用 `；` 连接；≤160 字符；去掉领域标记 |
| ex | string | 一条英文例句，可为 `''` |
| exZh | string | 例句中译，可为 `''` |
| mask | number | bit: 1 四级、2 六级、4 专四、8 专八、16 雅思、32 托福（可多选） |
| lvl | number | 难度 1–4（1 最易），无则 1 |
| forms | string | 空格分隔的屈折形式（不含词条本身），如 `abandoned abandoning abandons`；≤8 个 |

预计 12k–20k 条，文件 ≤ 5 MB。**必须先产出可用的完整版本**，再考虑优化体积。

### 3.2 `js/data/dict.js`（兜底词典）

```js
window.DR_DICT = { v: 1, words: [ [word, ipa, zh, mask, forms, rank], ... ] };
```

| 字段 | 要求 |
|---|---|
| word | 单个英文词（可含连字符/撇号，不含空格），忽略大小写唯一；**不重复收 DR_EXAM 已有的词** |
| ipa | 同 exam，可空 |
| zh | 中文释义，≤120 字符，保留词性前缀，去领域行 |
| mask | 由 ECDICT `tag` 映射：cet4→1, cet6→2, ielts→16, toefl→32；无则 0 |
| forms | 屈折形式，空格分隔，≤8 |
| rank | 频次序（`bnc`/`frq` 取较小非零值；0=未知） |

选词规则（目标 50k–90k 条、≤ 6 MB）：`tag` 非空 ∪ `collins>0` ∪ `oxford=1` ∪ `bnc>0` ∪ `frq>0`
的单字词，且 translation 清理后非空；按 rank 取前 90k。文件必须 ≤ 6 MB（超了降数量，先保高频）。

### 3.2.1 `js/data/d2/d2-<letter>.js`（扩展词库桶，按需加载）

```js
window.DR_D2 = window.DR_D2 || {};
window.DR_D2[letter] = [ [word, ipa, zh, mask, forms, rank], ... ];   // 字段同 dict.js
```

- 存放 `dict.js` 装不下的单字词（生僻词、无音标词、主清理失败的条目），按**词首字母**分桶（`a`–`z`），
  首屏只加载 exam；`dict.js` 仍是懒加载；只有当某个词在 exam + dict.js 里都查不到时，
  才注入它首字母对应的那一个桶（单桶 0.3–1.9 MB）。
- 扩展层 `forms` 恒为空（靠 `lemmaCandidates` 还原屈折），`zh` 可能不带词性前缀
  （宽松清理的产物：`[法]` 之类领域标记会被剥掉、括号注记会被去掉）。
- 全库合计约 38 万单字词；验收：`node tools/test-dict2.js`。

### 3.3 `js/data/affixes.js`

```js
window.DR_AFFIX = { v:1, items: [ { a:'un-', type:'前缀', zh:'不、非；相反动作', ex:['unhappy','unlock'], note:'' }, ... ] };
```

来自 affixes.json.gz，字段名对齐；用于兜底提示「未收录，但 …」。

### 3.4 数据统计与验收（lex-builder 自测）

`node tools/report-dict.js` 必须输出：exam 条数 / dict 条数 / 文件体积 / mask 分布 /
在下面三段样本上的**词形覆盖**（按 token，忽略大小写，允许原形命中）：

```
It was a bright cold day in April, and the clocks were striking thirteen.
The committee, which had been deliberating for nearly six hours, finally reached a conclusion that satisfied neither the union representatives nor the management.
Scientists have discovered that the deep-sea creature, previously thought to be extinct, is capable of regenerating damaged tissue.
```

覆盖率目标：普通文章 token 覆盖率 ≥ 98%（含 the/a 等基础词，来自 ECDICT 高频段）。

## 4. 运行期 API 契约

### 4.1 `DR.text`（Lead 已实现，冻结）

`js/engine/text.js` 提供：

```js
DR.text.tokenize(text)  // => [{ t, s, e, k, w? }]
//   覆盖整个输入、无缝隙；k: 'w' 单词 | 's' 空白 | 'p' 标点/其他
//   单词 token 带 w = 小写形式；s/e 为原文偏移（左闭右开）

DR.text.words(text)     // => [{t,s,e,w}] 只要单词 token
DR.text.splitSentences(text) // => [{ text, start, end }]（text 已 trim，start/end 指向原文）
DR.text.paragraphs(text)     // => [string]（空行分段；无空行时按行分段；段内单换行转空格）
```

解析引擎与 UI 都必须使用这套 tokenizer，禁止另写一份。标点/空白 token 不参与成分标注。

### 4.2 `DR.analyze`（parser-engine 实现）

```js
DR.analyze.load()        // => Promise，首次调用时动态插入 <script src="js/data/pos-lex.js">（file:// 可用）
DR.analyze.ready()       // => boolean
DR.analyze.sentence(text) // => 见下；text 为单句文本；未 ready 时抛 Error('not-ready')
DR.analyze.legend        // => [{ id:'subj', zh:'主语', color:'#2A7F76', desc:'动作的发出者/被说明的对象' }, ...]
DR.analyze.posZh         // => { noun:'名词', verb:'动词', ... }
```

`sentence()` 返回：

```js
{
  text: string,
  tokens: [ { t,s,e,k:'w',w, pos, role, phrase, clause } ],
  //   tokens 必须与 DR.text.tokenize(text) 中的单词 token 一一对应（数量/顺序/偏移完全一致）
  //   pos:  'noun'|'verb'|'adj'|'adv'|'prep'|'conj'|'pron'|'det'|'num'|'aux'|'modal'|'part'|'interj'|'propn'
  //   role: 'subj'|'pred'|'obj'|'comp'|'adv'|'attr'|'aux'|'det'|'prep'|'conj'|'mark'|'rel'|'nonfin'|'appos'|''
  //   phrase: 'NP'|'VP'|'PP'|'AdjP'|'AdvP'|'Clause'|'InfP'|'GerP'|'PartP'|''
  clauses: [ { i:0, start, end, type:'main'|'coord'|'sub'|'rel'|'nonfinite', label:'主句' } ],
  summary: '主语 + 谓语 + 宾语',           // 中文结构概括，可为 ''
  structure: [ { role:'subj', start, end, text } ], // 主干成分，按句序（UI 会按 start 排序）；可空数组
  notes: [ { kind:'passive', title:'被动语态', detail:'…', start, end } ],
  //   kind 稳定取值：passive | perfect | progressive | modal | relative | noun-clause |
  //   adverb-clause | nonfinite-infinitive | nonfinite-participle | nonfinite-gerund |
  //   coordinated | inversion | expletive-it | existential-there | appositive | comparative |
  //   ellipsis | 'other'
  confidence: 0.0–1.0
}
```

要求：

- 纯函数、无 DOM 依赖、单句分析 < 20 ms；对空串/无动词/全大写/引号/破折号等退化输入不抛异常，
  返回结构完整、`confidence` 低。
- 标注是**启发式**，`docs/ANALYSIS.md` 必须写清规则、已知错误类型与置信度含义。
- `tools/test-analyze.js` 跑 `tools/gold-sentences.json`（≥60 句，人工标注 POS 与主干成分），
  输出 POS 准确率与主干角色准确率；简单句目标 POS ≥ 85%、主干 ≥ 75%。如实报告，不粉饰。
- POS 数据 `js/data/pos-lex.js`：`window.DR_POS = { v:1, w:{ 'word':'noun' } }`；为消解同形歧义，值允许
  `'verb|noun'`（第一段为主词性，UI/调用方取第一段即可）。
  由 `tools/build-pos.js` 从 ECDICT（definition 的 WordNet 词性前缀 + translation 前缀）生成，
  含常见屈折形式；体积 ≤ 5 MB；必须可重建。

### 4.3 `DR.dict`（Lead 实现，供 UI 使用）

```js
DR.dict.lookup(rawWord) // => { w, ipa, zh, ex, exZh, packs:['cet4',...], mask, lvl, forms:[], source:'exam'|'full', viaForm? } | null
DR.dict.search(q, limit)     // => [{...}] 前缀/包含匹配，按 rank 排序
DR.dict.resolve(raw)         // => { entry, raw, matched, via:'exact'|'form'|'lemma'|'possessive' } | null（同步，仅 exam + 已加载的层）
DR.dict.resolveAsync(raw)    // => Promise<同上>：exam → dict.js → 首字母桶 d2-<letter>.js，全部按需
DR.dict.ensureFull()         // => Promise 懒加载 js/data/dict.js
DR.dict.ensureBucket('u')    // => Promise 懒加载 js/data/d2/d2-u.js
DR.dict.hasFull()            // => boolean
DR.dict.packs                // = DR_EXAM.packs
```

查词必须处理：大小写、撇号（isn't）、所有格（dogs' → dog）、复数/过去式/进行时/比较级还原
（优先后缀规则 + `forms` 反查表）。

## 5. UI / DOM 契约（Lead 实现，qa-verify 依赖）

页面外壳为顶部栏 + 主区域，三个主 TAB（hash 路由：`#/read`、`#/notebook`、`#/dict`）：

| 选择器 | 作用 |
|---|---|
| `#app` | 应用根 |
| `#tabs` / `#tab-reader` / `#tab-notebook` / `#tab-dict` | 主 TAB |
| `#theme-toggle` | 深浅色切换 |
| `#settings-open` / `#settings-modal` | 设置面板 |
| `#library` / `#library-list` / `#btn-new-article` | 文章库侧栏 |
| `#paste-modal` / `#paste-text` / `#paste-title` / `#btn-paste-start` | 粘贴新文章 |
| `#article-body` / `#article-meta` / `#article-title` | 阅读区 |
| `#btn-save-article` / `#btn-delete-article` | 文章操作 |
| `#btn-sentence-mode` | 成分模式开关（开启后点句子任意位置看成分） |
| `#btn-analyze-sentence` | 词卡内「看这句成分」 |
| `Alt / ⌥ + 点击句子` | 不切模式直接看成分 |
| `#inspector` / `#word-card` / `#sentence-card` | 右侧检查面板 |
| `#btn-add-word` / `#btn-speak-word` | 单词卡操作 |
| `#notebook-list` / `#notebook-stats` / `#notebook-search` / `#notebook-filter`（select） / `#btn-review` | 生词本 |
| `#review-modal` / `#review-card` / `#review-reveal` / `#btn-rate-1|2|3` | 复习闪卡 |
| `#dict-search` / `#dict-result` | 词库页 |
| `#toast-layer` | 提示条 |

所有可交互控件用 `<button>`/`<a>`/`<input>` 原生语义，带 `aria-label` 或可见文字；点击单词用
`data-w`（小写）标注、用事件委托，禁止给每个词绑独立事件。

QA 可用 `window.DR.debug`（Lead 提供）：`{ state, openArticle(id), clickWord(w), analyzeSentence(text) }` 便于脚本化，
但主要测试路径必须是真实用户操作（点击/输入/滚动）。

## 6. localStorage schema

```js
// dr.articles.v1 : [
//   // 普通文章
//   { id, title, text, createdAt, updatedAt, progress:0 },
//   // 电子书（v1.2 新增；正文不进 localStorage，见 §6.1）
//   { id, title, author, kind:'book', chapterCount, chapterTitles:[], wordCount,
//     chapterIndex, source:'epub'|'txt', progress, createdAt, updatedAt }
// ]
// dr.notebook.v1 : { v:1, order:[key...], items:{ [key]: {
//     key, w, lemma, ipa, zh, packs:[], ex, exZh, forms:[],
//     firstAt, lastAt, count,                 // count=查词次数
//     status:'new'|'learning'|'known',
//     dueAt, interval(天), ease, reps, lapses,
//     contexts: [{ text, articleId, title, at }]   // 最多 5 条，含该词的原文句子
// } } }
// dr.settings.v1 : { v:1, theme:'light'|'dark', fontScale:1, lineHeight:1.9,
//                    marks:true, autoAdd:true, showRoles:false,
//                    readFont:'newsreader', customFont:'', reviewMode:'mix' }
// dr.stats.v1    : { v:1, byDay:{ 'YYYY-MM-DD': {looked, added, reviewed} } }
```

key 规范：`word` 取词典词头的小写；同一个词的屈折形式合并到同一 key，`w` 保留首次查到的拼写形态。
`contexts` 里存原句文本，复习时作为语境提示。

### 6.1 IndexedDB 书库（大书正文）

localStorage 单域名约 5 MB，一本长篇（百万词）就有 6 MB 正文，塞不下。所以电子书只把**书目元数据**
写进 `dr.articles.v1`，章节正文放 IndexedDB：

```js
// database: deepread  (version 1)
// object store: chapters  keyPath: 'id'
// { id: <article.id>, v:1, savedAt, chapters: [ { title, book, text } ] }
```

`js/core/books.js`：`DR.books.{put,get,del,has,usage}`；删除文章时同步删掉书籍记录。
`file://` 下 IndexedDB 可用（Chromium 系）；不可用时导入会明确报错，不会静默丢数据。

### 6.2 备份格式（导出 / 导入）

```js
// deepread-backup-YYYYMMDD.json
// { app:'DeepRead', v:2, exportedAt, activeId,
//   articles:[...],                          // 含 progress / chapterIndex
//   books:{ [articleId]: [{title, book, text}] },  // 电子书正文（IndexedDB 里的那份）
//   notebook, settings, stats }
```

- 由 `js/core/backup.js` 生成：`DR.backup.build()` → `download()` → `importBundle(obj, {mode:'merge'|'replace'})`。
- 导入默认 **merge**：文章按 id 合并（同 id 以文件为准），生词按词合并；`replace` 会先清空本地书籍记录。
- v1 老备份（只有 localStorage 部分）仍可导入。

### 6.3 电子书导入

- 入口：粘贴弹窗的「导入文件」/ 拖放，接受 `.epub`、`.txt`、`.md`。
- 解析：`js/core/ebook.js`（零依赖）——zip 用 `DecompressionStream('deflate-raw')`，
  元数据读 `META-INF/container.xml → OPF` 的 `dc:title` / `dc:creator`，
  章节优先按 `toc.ncx` / `nav.xhtml`（含两级目录：书 → 章），没有目录时一个 spine 文件一章。
- 纯文本分章：`Chapter X` / `PART X` / `第X章` / 序章·楔子·尾声；无章节且超过 3 万字符时按段落分段。
- 正文清洗：页眉页脚（书名/作者重复行）、纯页码、章首 `• I • II` 导航、目录点线、两端对齐多余空格。
- 验收：`node tools/test-ebook.js`（解析）与 `node tools/test-import.js`（浏览器端导入/分章/持久化）。

## 7. 视觉规范（Lead 定稿）

- 双主题：浅色 `day`（米白纸面 + 墨色字）与深色 `night`（深海夜色 + 浅字）。默认跟随系统，可手动切换。
- 字体（v1.1 修订，用户要求）：标题 Fraunces；英文阅读 Newsreader（默认，可切 Literata / JetBrains Mono /
  Inter / 系统衬线 / 自定义）；界面与音标 Inter；中文译文霞鹜文楷 WenKaiCN；数字与词形 JetBrains Mono。
  中英文混排正文 19px，行高 1.9，阅读行宽约 70ch。
- 版式：**顶部栏 + 三栏**（文章库 260px | 阅读区 | 检查器 320px），阅读区最大 74ch；
  ≤1100px 收起文章库（抽屉），≤820px 检查器变底部抽屉，单栏阅读。
- 主色 `--accent: #2F6F6A`（海玻璃绿）；词级色：四级 `#2A7F76`、六级 `#3B6FB0`、
  专四 `#A9752C`、专八 `#7B57A6`、雅思/托福 `#6B7C8A`。
- 成分角色色见 `DR.analyze.legend`；UI 用**下划色/标签**而不是整块底色，保证正文可读。
- 视觉务必与参考站 `Again_PokemonEnglish` 区分：不要奶油+珊瑚色、不要深色侧栏、不要故事卡片、
  不要宝可梦/角色/立绘。整体要像「一张安静的专业阅读台」。

## 8. 验收（Lead 与 qa-verify 共同执行）

1. 双击 `index.html`（file://）能打开，无控制台报错；`#/read`、`#/notebook`、`#/dict` 可切换。
2. 粘贴一篇 ≥600 词英文文章 → 出现可点单词；点 `ubiquitous`/`deliberating`/`were` 等分别查到
   词头还原、音标、释义、词级、例句；发音按钮可用（没有语音时给出提示而不是报错）。
3. 查 5 个词后切到生词本：5 个词都在，含原文语境；刷新后仍在；搜索/筛选/标记已掌握可用。
4. 复习流程：进入复习 → 翻卡 → 三档评分 → 结束后有汇总；再次进入时按到期时间筛选。
5. 句子分析：点击句子 → 检查器出现主干、成分与语法点；明显错误可以在 UI 上容忍但要标注
   「自动推断」；切换角色着色能还原。
6. 文章保存/切换/删除；刷新后文章与进度还在。
7. 深色主题、字号调节、移动端窄屏（420px）无横向溢出。
8. `node tools/browser-check.js` 截图 + 控制台错误检查全绿；`node tools/ui-test.js` 交互冒烟全绿。

## 9. 数据来源与许可（README/CREDITS 必须写）

- 六套考试词库：`DSH_learninguse/assets/vocab`（源：KyleBing/english-vocabulary MIT + ECDICT MIT）
- ECDICT（MIT）：`skywind3000/ECDICT`，中文释义、音标、词形
- 词根词缀：DSH_learninguse 整理
- 代码与界面：本项目原创（MIT）；不复制参考站的代码与视觉资产
