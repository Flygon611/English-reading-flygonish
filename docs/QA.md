# 深读 DeepRead · QA 验收报告（最终）

> 负责人：qa-verify｜契约：`CONTRACT.md`（v1.1，含自托管字体修订）
> 结论只来自真实运行输出：**没跑通就是没跑通，不放宽断言、不粉饰**。
> 最后更新：2026-10-26 13:2x（代码冻结候选后最终回归）

## 0. 最终结论

| 项 | 结果 |
|---|---|
| `node tools/browser-check.js` | ✅ **全绿**：2 入口（file:// + http）× 6 路由，失败 0 / 警告 0 / 截图 14 |
| `node tools/ui-test.js` | ✅ **通过**：11 步（T0–T10）、断言 235 通过 / 0 失败 / 1 警告（settings 懒写入，已解释）、截图 20（Lead 最终复跑 2026-10-26 13:3x） |
| 契约 §8 验收 8 条 | ✅ 全部覆盖并通过（见 §3 矩阵） |
| 真实缺陷 | 2 个均已修复并复验：自定义阅读字体不生效（D-01）、重复 DOM id（L-01，已改为路由离开时清理另一侧检查器） |
| 发布阻塞 | **无** |

测试环境：Windows / Node v24.20.0 / Edge `Edg/156.0.4314.42` / CDP 独立 profile（每次全新 temp user-data-dir，测试前后不污染用户数据）。

版本信息（本轮 `DR.debug.state()` 实测）：

```json
{ "route": "read",
  "notebook": { "total": 0, "known": 0, "learning": 0, "fresh": 0, "due": 0 },
  "dict": { "exam": 16638, "full": 0, "fullLoaded": false },   // T0 时刻；全量词典懒加载
  "analysis": false,                                            // analyze 懒加载，点句后 ready
  "settings": { "theme": "light", "readFont": "newsreader", "fontScale": 1, "marks": false, "autoAdd": true } }
```

数据/引擎版本（实测）：`DR_EXAM.words.length = 16638`；懒加载后 `DR.dict.stats() = { exam:16638, full:60000, fullLoaded:true }`；
`DR_AFFIX.items.length = 202`；`js/data/pos-lex.js` 存在（点句后 `DR.analyze` 就绪）。
POS 97.0% / 主干中心词 100% 为 parser-engine 自评测数据（金标自建），**本报告未独立复测该指标**，
只验证 UI 契约：结构存在、按句序、置信度与「自动推断 · 仅供参考」标注。

## 1. 怎么跑

```bat
:: 浏览器检查：file:// 与 http://127.0.0.1:8787/ 双入口 × #/read #/notebook #/dict × 1440/420
node tools/browser-check.js
node tools/browser-check.js --base file          :: 只测双击场景
node tools/browser-check.js --theme dark         :: 截图用深色（默认 light，固定主题便于看版式）
node tools/browser-check.js --selftest           :: 不需要应用，验证 CDP/截图链路本身

:: 交互冒烟（默认 file://；--base http 走本地服务）
node tools/ui-test.js
node tools/ui-test.js --only T8,T10              :: 只跑指定步骤（会先自动打开应用）
node tools/ui-test.js --plan                     :: 只校验测试数据（词数/目标词）
node tools/ui-test.js --selftest                 :: 验证测试助手/事件/截图链路
```

环境：Node ≥ 22（内置 `WebSocket`/`fetch`，**不装 puppeteer**）；Edge 路径可用 `EDGE_PATH` 覆盖；
端口：CDP 9223（browser-check，被占自动顺延）/ 9224（ui-test）、本地服务 8787（`DR_PORT`）。
退出码：`0` 通过 ｜ `1` 有失败 ｜ `2` 环境阻塞（应用不存在 / 无 Edge）。

产物：`preview/browser-check.json`、`preview/ui-test.json`（含每条断言期望/实际、DOM 摘要、截图路径、`toolFailures`），
截图 `preview/bc-*.png`、`preview/ui-*.png`（清单见 §7）。

## 2. 测试资产

- **T1 长文**：内置在 `tools/ui-test.js`，649 词 / 6 段，含 `ubiquitous`、`deliberating`、句首 `Were`、`committee`、`quay`。
- **T9 短文**：含所有格 `children’s` / `government’s`、缩写 `isn’t`、数字 token `1990s`（`Last year’s` 作补充）。
- **真实交互**：`Runtime.evaluate` 派发完整 `pointerdown→mousedown→pointerup→mouseup→click`（带 clientX/Y 与 `scrollIntoView`），
  输入走原生 value setter + `input`/`change`；句子点击用 `Range` 取坐标 + `elementFromPoint`（落在句内标点，保证不点到 `.w`）；
  需要浏览器默认行为（聚焦/失焦）的地方改用 **CDP Input 域** 的真实受信任输入。
- **交叉验证**：不只信 UI，同时读 `localStorage`（`dr.notebook.v1` / `dr.articles.v1` / `dr.settings.v1`）核对状态。
- 每步失败都会打印：选择器、期望/实际、页面 DOM 摘要（hash/overlays/toasts/条数）、截图路径。

## 3. 覆盖矩阵（契约 §8）

| §8 | 验收要求 | 落点 | 结果 |
|---|---|---|---|
| 8.1 | file:// 能开、无控制台报错、三 TAB 可切换 | browser-check 入口+3 路由；T0/T7/T10 真实点击 TAB | ✅ 0 console error / 0 未捕获异常 / 0 失败请求（含字体），激活 TAB 校验通过 |
| 8.2 | 粘贴 ≥600 词 → 可点单词；`ubiquitous`/`deliberating`/`were` 词头还原/音标/释义/词级/例句；发音不报错 | T1（649 词、649 个 `.w[data-w]`、35 句）；T2 五词逐个点查 | ✅ `deliberating → 原形：deliberate`、`Were → 词头 were / 原形：be`；音标/词级/例句齐；点发音无异常（无语音时 toast 提示） |
| 8.3 | 查 5 词 → 生词本 5 条含语境；刷新仍在；搜索/筛选/标记 | T3（补查 committee/quay 凑 5 词；`reload` 后 5/5；搜索 unique=1；筛选 known=1；标记后存储 `status:"known"`） | ✅ 语境句 `.nb-context__text` 含目标词且 ≥20 字符，日期相对时间「刚刚」 |
| 8.4 | 复习：进入→翻卡→三档评分→汇总；再进入按到期筛选 | T4（1/4 进度、翻面答案出现、4 张评分、`#review-done` 三档计数、`reps 0→4`、再进入开「巩固模式」） | ✅ 汇总容器 `.review__summary` = `0 认识 4 模糊 0 不认识` |
| 8.5 | 点句子 → 主干/成分/语法点；明示「自动推断」；角色着色可还原 | T5 多句采样（结构行按句序、置信度 63%、`.note-item` 语法点、`#btn-role-toggle` 着色 `.w.role--*` 33 个 → 0） | ✅ 句 0：`主语+谓语+表语` 3 行；句 13：`谓语+宾语` 2 行且按句序；着色开关可逆 |
| 8.6 | 文章保存/切换/删除；刷新后正确 | T6（保存、第二篇、库里切回、contenteditable 改标题 blur 落库、删除、reload 后剩 1 篇且 progress=0） | ✅ |
| 8.7 | 深色主题、字号、420px 无溢出 | T7（浅↔深两档均到达并各截图；`#font-inc` 19→19.95px 且可还原；`#set-font` 存在；三路由 `scrollWidth==innerWidth==420`） | ✅ |
| 8.8 | 两脚本全绿 | 本报告 §0 | ✅ |

补充覆盖（超出 §8 但会伤人）：字体系统（6 面加载 / 6 档切换 / custom / reload 持久化）、所有格与数字 token、
词库页统计与搜索、file:// localStorage 读写、重复 id 观察、`viewport` meta、控制台/请求级错误。

## 4. 字体系统专项（v1.1 新增）

- `document.fonts` 6 个字体面全部 `status: "loaded"`（file:// 与 http 均验证）：
  Fraunces / Newsreader / Inter / WenKaiCN / Literata / JetBrains Mono。
- `document.fonts.check('16px "…"')` 六项均为 `true`；全程 **0 个字体请求失败**。
- `#set-readfont` 六档实测：`literata→Literata`、`mono→JetBrains Mono`、`sans→Inter`、`system→系统衬线栈（不含自托管字体）`、
  `newsreader→Newsreader`、`custom + Georgia→Georgia`；`data-read-font` 与 `dr.settings.v1.readFont` 同步。
- reload 后：`readFont=newsreader`、`fontFamily` 仍含 Newsreader、`fonts.check('16px "Newsreader"')=true`。
- 正文行宽实测 **668px**、字号 19px、行高 36.1px（约 70 字/行），与 Lead 定稿一致（未写死旧值 780）。

## 5. 缺陷清单

### 5.1 已发现并已修复（本轮回归验证通过）

| # | 严重度 | 位置 | 现象 | 期望 | 修复 | 验证 |
|---|---|---|---|---|---|---|
| D-01 | 中 | `js/views/settings.js:169` + `css/tokens.css` | 阅读字体选「自定义…」并输入 `Georgia` 后，`#article-body` 计算字体回落到 `Inter, …`（UI 无衬线栈），自定义字体不生效 | 生效为 `Georgia, … serif` | inline `--font-read: "Georgia", var(--font-serif-stack)` 引用的 `--font-serif-stack` **全站未定义** → computed-value 解析失败 → 继承 body `--font-ui`。Lead 在 `tokens.css` 补齐该变量 | ✅ 修复后实测 `computed --font-read` 正常展开，T8 28 条断言通过；截图 `ui-08-font-*` |

复现与证据（修复前）：`document.documentElement.style.getPropertyValue('--font-read')` = `"Georgia", var(--font-serif-stack)`，
而 `getComputedStyle(documentElement).getPropertyValue('--font-serif-stack')` = `""`；截图 `ui-fail-T8.png`（修复前）。

### 5.2 已知、未修、非阻塞

| # | 严重度 | 现象 | 影响 | 建议 |
|---|---|---|---|---|
| L-01 | 低 | 词库页打开词条后，DOM 同时存在两个 `#word-card`（阅读页 `#inspector` 里残留 + 词库页 `#dict-detail` 新建）；重复 id 共 5 个：`word-card / word-card-word / btn-speak-word / btn-add-word / btn-known-word` | 应用代码不依赖全局 id，功能无影响；但违反 §5「选择器唯一」与 HTML id 唯一性 | **Lead 已修**：`js/app.js` 路由切换时 `route !== 'read'` → `DR.reader.clearSelection()`、`route !== 'dict'` → `DR.dictionary.closeDetail()`；复验 `document.querySelectorAll('#word-card').length === 1`（阅读页/词库页切换后都是 1） |

## 6. 已知限制（非缺陷，不当发布阻塞）

1. **句子分析是规则启发式**：同一篇文章里 4 句采样中，2 句给出主干行（`主语+谓语+表语` / `谓语+宾语`），
   另 2 句（33/22 词长句）退化为「未能可靠识别主干（自动推断结果仅供参考）」，但逐词词性/角色与语法点仍在；
   UI 已用「自动推断 · 仅供参考 + 置信度 63%」明示。符合契约「允许出错、必须标注」。
2. **屈折形式的音标来自原形**：`were` 显示 `/biː/`、`isn’t` 显示 `/biː/`（词头保留原拼写、释义与原形行正确）。
   建议词卡在原形音标旁标注 `（原形 be）`，避免误读（见 §8-E）。
3. **全量词典懒加载**：首屏 `DR.dict.stats().full === 0`，首次查生僻词会等 `dict.js`（60,000 条）加载；实测 file:// 下加载正常。
4. **`dr.settings.v1` 懒写入**：首次启动不落盘（只有改过设置才写），`DR.store.settings()` 已返回完整默认值；不视为缺陷。
5. `--only` 局部跑步骤时，前面的步骤不会执行（脚本会自动先打开应用，但文章/生词本等状态为空），仅用于定位问题。
6. `browser-check` 在 file:// 下 `performance.getEntriesByType('resource')` 拿不到字体请求数（Chromium 限制），
   因此字体加载以 `document.fonts` 面状态为准（更可靠）。
7. 本轮修过的**测试自身**缺陷（不是应用问题，记录以便复跑）：`#notebook-filter` 复位用空值导致空列表、
   书库行点到了 `li` 而非 `button[data-id]`、句析只等「卡片可见」抓到加载骨架、词库页把「最近查过」列表当成搜索结果并点了已被替换的节点、
   420 视口用了 `mobile:true`（布局视口 980px，等于没测）。均已修正。

## 7. 截图索引（`preview/`，共 34 张）

**browser-check（14 张，固定浅色）**

| 文件 | 内容 |
|---|---|
| `bc-file-entry-1440.png` / `bc-http-entry-1440.png` | 双入口首屏（file:// / http） |
| `bc-file-read-1440.png`、`bc-file-notebook-1440.png`、`bc-file-dict-1440.png` | file:// 三路由 1440×960 |
| `bc-http-read-1440.png`、`bc-http-notebook-1440.png`、`bc-http-dict-1440.png` | http 三路由 1440×960 |
| `bc-file-read-420.png`、`bc-file-notebook-420.png`、`bc-file-dict-420.png` | file:// 三路由 420×900 |
| `bc-http-read-420.png`、`bc-http-notebook-420.png`、`bc-http-dict-420.png` | http 三路由 420×900 |

**ui-test（20 张；按步骤）**

| 文件 | 内容 |
|---|---|
| `ui-00-env.png` | 环境/首屏（统一浅色后） |
| `ui-01-paste-read.png` | 649 词长文渲染完成（可点词 + 句子） |
| `ui-02-wordcard.png` | 词卡：词头/音标/词级/释义/例句/IN CONTEXT/操作 |
| `ui-03-notebook.png` | 生词本：统计/筛选/5 行词条/状态 |
| `ui-04-review-card.png` | 复习闪卡翻面后（含三档评分） |
| `ui-04-review-done.png` | 本轮汇总 `#review-done`（三档计数） |
| `ui-04-review.png` | 复习收尾后生词本页 |
| `ui-05-sentence.png` | 句子成分卡（主干/逐词/语法点/置信度） |
| `ui-05b-role-on.png` | 原文角色着色开启状态 |
| `ui-06-articles.png` | 文章库保存/切换后的阅读页 |
| `ui-07-dark.png`、`ui-07-light.png` | 深/浅两档主题 |
| `ui-07-420-read.png`、`ui-07-420-notebook.png`、`ui-07-420-dict.png` | 三路由 420×900 无横向溢出 |
| `ui-08-font-literata.png`、`ui-08-font-mono.png` | 阅读字体切换（Literata / JetBrains Mono） |
| `ui-08-font-reload.png` | 字体设置 reload 后保留 |
| `ui-09-possessive.png` | 所有格/缩写词卡（`isn’t` → 原形 be） |
| `ui-10-dict.png` | 词库页：六库统计/搜索结果/词条卡 |

## 8. 独立设计评审（基于上列截图，非泛泛而谈）

> 总体判断：视觉方向达成「一张安静的专业阅读台」——米白纸面 + 海玻璃绿 + 衬线正文 + 克制的分隔线；
> 与参考站（奶油+珊瑚、深色侧栏、故事卡）明显区分。以下按优先级给可执行建议。

**A. Toast 位置与深色观感（P2）**
- 证据：`ui-01-paste-read.png` 两条 toast（「浅色模式」「文章已添加」）叠在正文第 2 段上；
  `ui-10-dict.png` 底部中央残留「文章已添加」；`ui-07-dark.png` 深色主题下 toast 是纯白药丸，突兀。
- 建议：`#toast-layer` 从底部居中改为**右下角**（`right: 24px; bottom: 20px; align-items: flex-end`），
  避开阅读区中轴；同屏最多 2 条、`--dur` ≤ 2200ms；深色主题背景用 `--surface-2` + 文字 `--ink`（禁止 #fff）。
  若坚持底部居中，至少把 `position` 放在阅读区之外（检查器下方），不要压正文。

**B. 首屏信息重复（P2）**
- 证据：`bc-file-read-1440.png` 空态：阅读区有 4 张 onboarding 卡（粘贴/逐词查/留痕/看成分），
  右侧 320px 检查器空态又重复同样 4 条（点单词/点句子/生词本/A+），首屏 23% 宽度放重复内容。
- 建议：空态时检查器隐藏该 4 条，只留「词级下划线」图例 + 快捷键；或空态收窄检查器
  （`body[data-empty="1"] #inspector { display:none }`，阅读区即可用 130ch 展示 onboarding 卡）。

**C. 420px 生词本工具栏占 3 行（P2）**
- 证据：`ui-07-420-notebook.png` 搜索框 + （状态/词级）+ 排序 = 3 行约 150px，占视口 17%。
- 建议：≤480px 时 `#notebook-sort` 收到状态行（两列网格），或三个 select 合并进「筛选」按钮弹层；
  首屏应保证至少 3 条词条可见（当前 1.5 条）。

**D. 420px 文章 meta 行孤立的 `·`（P3）**
- 证据：`ui-07-420-read.png` 末尾 `… 0% ·`——隐藏「点词查词 · 点句子看成分」后残留分隔符。
- 建议：`.sep:last-of-type { display:none }` 或把提示与它前面的 sep 一起包进 `.reader__hint` 容器，断点内整块 `display:none`。

**E. 屈折形式音标易误读（P3）**
- 证据：`ui-02-wordcard.png` 的 `were /ˈbiː/`、`ui-09-possessive.png` 的 `isn’t /biː/`、`ui-03-notebook.png` 行内 `were /biː/`。
- 建议：`lemmaShown` 为真时音标容器追加淡色后缀 `（原形 be）`，例如 `/ˈbiː/ · 原形 be`；
  或音标用原形色 + `title="该音标来自原形 be"`。生词本行内同理。

**F. 词库页统计行层级（P3）**
- 证据：`ui-10-dict.png`：`四级 4,544 六级 3,989 专四 4,337 专八 12,399 雅思 5,270 托福 10,349` 为 11.5px 灰字，
  与上一行「考试词库 16,638 条 · 兜底词典 60,000 条」信息重叠、密度过高。
- 建议：六个库计数改为与 `packBadge` 同色的 chip 行（可换行），或折叠为「六库分布 ▾」；
  第一行只留「本机 76,638 条 · 离线可用」，去掉重复的「考试词库/兜底词典」两段。

**G. 词卡 IN CONTEXT 行宽（P3）**
- 证据：`ui-02-wordcard.png` 检查器 320px 内 12px 灰字行长达 48+ 字符。
- 建议：`.context__text { font-size:12.5px; line-height:1.7; max-width:30ch }`，或该块改 13px 并加左内边距竖线。

**H. 深色主题细节（P3）**
- 证据：`ui-07-dark.png`：检查器标题「点一个词，或者一句话」纯白，比正文更抢眼；词级图例「雅思/托福」`#6B7C8A` 在 `#0C1416` 上对比约 3:1。
- 建议：深色下 `#inspector .insp-empty__title { color: var(--ink-2) }`；雅思/托福色深色档提亮到 `#8FA0AE`（或加 1px 下划线的 alpha）。

**I. 生词本行右侧信息密度（P3）**
- 证据：`ui-03-notebook.png` 行右侧「查过 1 次 / 刚刚 / 待复习」三行叠放 + chevron，与词级标签左边界参差。
- 建议：给标签列固定 `min-width: 132px`（右对齐），meta 压成两行（`查过 1 次 · 刚刚`），状态 pill 单独一行右对齐；
  这样 5 行的右缘能对齐成一条直线，更像「阅读台」而不是列表堆叠。

## 8.5 Lead 发布前补丁（2026-10-26 13:5x）

- **句子分析入口**：新增顶部「成分」模式 `#btn-sentence-mode`、词卡内「看这句成分」`#btn-analyze-sentence`、`Alt / ⌥ + 点击`；
  同时修掉移动端点击检查器内按钮时「DOM 重渲染导致 event.target 脱树 → 被误判为点击外部 → 关掉底部卡片」的缺陷。
- **词级下划线**：改为按单词所属**最低门槛**词库着色（四级青 / 六级蓝 / 专四琥珀 / 专八紫 / 雅思托福灰），
  功能词不标，线宽 2px、提高饱和度；修掉此前「专八词库包含大量基础词 → 全篇几乎同色」的问题。
- **分析引擎补丁**：真实文章 16 句抽测从 8/16 有主干提升到 **16/16**；金标扩到 94 句，
  POS 97.9% / 主干中心词 100%（自建集，域外仍可能出错）；`docs/ANALYSIS.md` 已同步。
- **实时反馈**：查词自动入生词本后，文章里的灰底（`w--noted`）与顶部生词本徽标**立即**更新，不再需要刷新；
  左侧文章库进度条随阅读滚动实时更新（同时写回 localStorage）。修掉了「自动收入」路径不触发 `applyMarks/refreshBadges` 的遗漏。
- **复跑**：`browser-check` 全绿（2 入口 / 6 路由 / 0 失败）；`ui-test` 235 断言 0 失败 1 已知警告；
  截图已刷新到 `preview/`（含 `ui-05-sentence.png` 新句卡与 `ui-02-wordcard.png` 新词卡）。

## 8.6 Lead 追加：多题型复习（2026-10-26 14:1x）

- 新增 `js/core/quiz.js` 与生词本 `#review-mode`：混合 / 闪卡 / 看词选义 / 看义选词 / 语境填空 / 拼写 / 听音选词（有英语语音时）。
- 选择题干扰项自动生成：拼写邻居（共享 bigram + Damerau 编辑距离 ≤2）、释义近邻（中文 bigram 过滤同义）、同词性同长度兜底；
  语境填空优先放同词形（deliberated/deliberates），避免「一眼看出」。
- 自动判分并写 SRS：答对「认识」、拼写差一字母「模糊」、其余「不认识」；闪卡保留手动三档。
- 测试：新增 `tools/quiz-test.js`（167 项，0 失败，含选项唯一/恰好一个正确/拼写 accept/性能）；
  QA 的 T4 已改为先固定「闪卡」模式再跑原断言，最终 `ui-test` 235 断言 0 失败；浏览器实机另测了各题型、键盘 1–4/Enter、420px 无溢出。
- 截图：`ui-13-review-modes.png`、`ui-13-review-choice.png`、`ui-13-review-spell.png`、`ui-13-review-mobile.png`。

## 9. 复跑与判定口径（给后续维护者）

- 判定分级：**硬断言**（契约明确要求，失败即 FAIL）/ **软断言**（数据可能缺失或属于质量项，失败记 WARN 并进报告）/
  **已知限制**（记录但不判失败）。每类在报告 JSON 里可区分（`asserts[].status`）。
- 工具/应用分开：CDP 超时、截图失败、视口切换失败记入 `toolFailures`，**不误判为应用缺陷**，但会提醒「对应断言没跑到」。
- 数据变更窗口：若 `js/data/*.js` 被重建，先看 `DR.dict.stats()`/`DR_EXAM.words.length`，与冻结值（16,638 / 60,000 / 202）比对后再判定词条缺失类问题。
- 本轮最终产物时间：2026-10-26 13:2x（QA）、13:3x（Lead 修复 L-01 与 toast/移动端分隔符后复跑）：
`browser-check` 2 入口 / 6 路由 / 失败 0 / 警告 0 / 截图 14；`ui-test` 11 步 / 235 断言 / 失败 0 / 警告 1。
另：设计评审 P2-1（toast 位置）已按建议改到右下角并限制同屏 2 条；P3-4（420px meta 末尾孤 `·`）已隐藏；其余 P2/P3 为可选打磨，未阻塞发布。

## 8.7 Lead 追加：词库扩展 + 电子书导入（2026-10-26 14:4x–15:0x）

**词库**
- `dict.js` 仍为 6 万条（首屏不变）；新增 `js/data/d2/d2-a.js … d2-z.js`，按首字母 26 个桶、
  32.1 万条，点词未收录时只注入该词首字母那一个桶（0.3–1.9 MB）。
- `js/core/dict.js` 新增 `resolveAsync / ensureBucket`；阅读页未命中的词走异步补查，带占位卡与请求序号防竞态。
- 新测试 `tools/test-dict2.js`：13 项断言（首屏无桶、按字母加载、同桶只注入一次、未知词返回 null、点词出词卡），0 失败。
- 词库总池 38.1 万单字词；`unalienable / manacles / quicksands / ghettos / hilltops / alleghenies` 均可查。

**电子书**
- `js/core/ebook.js`（零依赖）：zip 中央目录 + `DecompressionStream('deflate-raw')`；`container.xml → OPF`
  取 `dc:title / dc:creator`；章节按 `toc.ncx`（含两级目录）或 `nav.xhtml` 切，无目录时一 spine 文件一章；
  正文清洗页眉页脚、页码、章首导航、目录点线、两端对齐空格。
- `js/core/books.js`：章节正文存 IndexedDB（`deepread/chapters`），`dr.articles.v1` 只存书目元数据。
- 阅读页：作者行、章节目录（下拉 + 上一章/下一章 + ←/→）、整本书进度按 `(章号 + 章内滚动)/总章数`。
- 实测：Animal Farm.epub（104 KB）0.5 s 出预览、10 章 / 30,230 词；
  Harry Potter 合订本（6.6 MB，300 个 xhtml）0.57 s、200 章 / 1,085,941 词，7 本分组正确（17/18/22/37/38/30/38）。
- 新测试：`tools/test-ebook.js`（15 项，含 TXT 分章、EPUB 元数据/章节/无空章）与
  `tools/test-import.js`（真浏览器 20 项：选文件 → 预览 → 导入 → IndexedDB 落盘 → 分章切换 → 刷新后仍在），均 0 失败。
- 截图：`ui-14-import-epub.png`、`ui-14-chapter-reader.png`、`ui-14-chapter-switch.png`、`ui-14-chapter-mobile.png`。

## 8.8 Lead 追加：整本书 + 进度打包（2026-10-26 15:2x）

- 备份升到 **v2**：`js/core/backup.js` 把 `dr.articles.v1`（含 `progress` / `chapterIndex`）+ IndexedDB 里的
  章节正文 + 生词本 + 设置 + 统计打成一个 `.json`；老 v1 备份仍可导入（只是没有电子书正文）。
- 设置 →「导出备份」会等正文取完再下载，并提示文件名 / 体积 / 章数；「导入备份」默认合并（同 id 以文件为准），
  可传 `mode:'replace'` 做整机覆盖。
- 跨设备路径：新设备打开站点 → 设置 → 导入备份 → 书架出现书目（`kind:'book'`）→ 打开即落回上次章节。
- 测试 `tools/test-backup.js`（11 项）：导入 epub → 读到第 3 章 → 打包 → 清空本地 → 导入 → 校验书目/正文/章节位置。
  Animal Farm 备份 167 KB；哈利波特合订本备份约 7 MB（百万词正文）。
