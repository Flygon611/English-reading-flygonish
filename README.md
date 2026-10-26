# 深读 · DeepRead

> 把一篇文章放进来，慢慢读。点词查本地词库，查过的词自动留在生词本里，之后回来复习。
> 纯静态、零构建、完全离线：双击 `index.html` 就能用，不联网、不注册、不上传。

一个给自己用的英语精读工具。不是课程，不是题库，也不讲故事——就是一张安静的阅读台：
**文章 → 点词 → 查义 → 留痕 → 复习**，另附一个「仅供参考」的句子成分分析。

![阅读](preview/ui-05-sentence.png)

![点词](preview/ui-02-wordcard.png)

![生词本](preview/ui-03-notebook.png)

![手机](preview/ui-07-420-read.png)

---

## 现在能做什么

### 阅读

- 粘贴任意英文文章（Ctrl/⌘ + V），或导入 `.txt` / `.md` / `.epub`；段落自动切分，保存进本地文章库。
- **电子书导入**：拖入 `.epub` 自动读出书名、作者，按目录分章（支持「书 → 章」两级，如七本合订的哈利波特 → 200 章）；
  正文存 IndexedDB，百万词也不占 localStorage。阅读页有章节目录 + 上一章 / 下一章（← → 键）。
- **换设备接着读**：设置 →「导出备份」把书架（含电子书正文、读到第几章、生词本、设置）打成一个 `.json`；
  新设备打开站点 →「导入备份」→ 书架和进度原样回来。Animal Farm 约 167 KB，哈利波特合订本约 6.2 MB。
- 逐词可点：音标、中文释义、词级（四级 / 六级 / 专四 / 专八 / 雅思 / 托福）、例句与中译、词形变化、发音。
- 词形还原：点 `deliberating`、`went`、`Were`、`children` 都能落到原形词条。
- 阅读进度、字号、行高、主题（浅色 / 深色 / 跟随系统）都记在本机。
- **阅读字体可换**：Newsreader（默认阅读体）/ Literata（另一种阅读体）/ JetBrains Mono（等宽连字）/
  Inter（无衬线）/ 系统衬线 / 自定义本机字体名；标题固定 Fraunces，中文译文用霞鹜文楷。
  设置里有字体与连字预览。
- 可选「词级下划线」：按单词所属**最低门槛**词库着色（四级青 / 六级蓝 / 专四琥珀 / 专八紫，
  雅思托福灰），功能词不标；默认关闭，避免干扰阅读。

### 生词本（单独一个 TAB）

- **每查一个词自动留一条记录**，连同它出现的那句原文（可在设置里关闭自动收录）。
- 独立页面：统计（收录 / 待复习 / 学习中 / 已掌握）、搜索、按状态和词级筛选、按时间/字母/查询次数排序。
- 展开词条能看到完整释义、词形、例句、原文语境；可标记「已掌握」、移出、朗读。
- **复习出题**：默认「混合题型」，也可以只练某一种：
  **看词选义**（四选一）、**看义选词**（四选一）、**语境填空**（原句挖空选词）、
  **拼写**（给中文与首字母，输入原形）、**闪卡**（翻面自评 1/2/3）、**听音选词**（系统有英语语音时可用）。
  选择/填空/拼写会自动判分并写入间隔重复（答对按「认识」，拼写只差一个字母按「模糊」）。
- **自动混淆项**：选择题干扰项不是随机词——拼写题优先取编辑距离 ≤2 的形近词（liberate / delineate / deliberately），
  选义题取释义相近但不同的词条，语境填空会把同一词形（deliberated / deliberates）放进来，避免一眼看出答案。
  键盘：数字键 1–4 选答案，Enter 下一题；闪卡仍是空格翻面、1/2/3 评分。
- 本轮结束有汇总；数据全部在 localStorage，可导出 / 导入 JSON 备份。

### 词库

- 全库搜索页：前缀 / 包含匹配，查词同样自动收入生词本。
- 数据量：**六套考试词库 16,000+ 条** + **ECDICT 兜底 6 万条**，全部随站点分发，运行期零请求。
- 未收录词（人名、专名、超纲）会给出词缀线索，而不是一句「查不到」。

### 句子成分分析（可选功能，启发式）

- 点击一句话（点句内标点/空白处）→ 右侧显示：主干（主语 / 谓语 / 宾语 / 表语）、
  逐词词性、语法点（被动语态、完成时、情态、非谓语、定语从句、状语从句、There be、形式主语等）。
- 可在原文给该句「着色」，用下划线颜色区分成分。
- **这是规则推断，会出错**：卡片会显示置信度，并明确标注「自动推断 · 仅供参考」。
  主干不确定时宁可少标，也不硬标；查词功能不受影响。

### 其他

- 三个主 TAB：阅读 / 生词本 / 词库；hash 路由可刷新保持。
- 深色模式、字号调节（85%–135%）、行高调节。
- 窄屏适配：≤1180px 文章库变抽屉，≤860px 检查器变底部卡片，手机单栏阅读。
- 无框架、无 npm 依赖、无网络请求；字体随站点自托管（OFL），离线可用；界面与代码原创。

---

## 怎么打开

**方式一：双击** `index.html`（Edge / Chrome）。`file://` 下功能完整，localStorage 可用。

**方式二：本地服务器（开发推荐，禁用缓存）**

```bash
node tools/serve.js 8787
# 打开 http://127.0.0.1:8787/
```

> 浏览器语音朗读使用系统自带语音（`speechSynthesis`）。系统里没有英语语音时，点发音会给出提示，
> 不影响查词。Windows：设置 → 时间与语言 → 语言 → 英语 → 语言选项 → 语音。

## 架到 GitHub Pages

纯静态、零构建，仓库根目录就是站点根目录（`.nojekyll` 已带，Pages 不会跑 Jekyll）：

1. 把本项目推到仓库的 `main` 分支。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **Deploy from a branch**，
   分支选 `main`、目录选 `/ (root)`。
3. 等一分钟，打开 `https://<用户名>.github.io/<仓库名>/`。

想用 GitHub Actions 发布也可以：`.github/workflows/` 里默认的 `ci.yml` 只跑自检（解析 + 打包），
不发布；要自动发布就把 `node tools/build-site.js` 生成的 `dist/` 用 `actions/upload-pages-artifact` 传上去。

本地先看看会发布什么：

```bash
node tools/build-site.js              # 生成 dist/（只含运行站点需要的文件）
node tools/serve.js 8801 --root dist --prefix /deepread/   # 模拟 Pages 子路径
# 打开 http://127.0.0.1:8801/deepread/
node tools/test-pages.js              # 子路径实跑：字体/词库/示例/查词/无 404
```

`dist/` 只打包运行必需的文件（`index.html`、`css/`、`js/`、`assets/fonts/`、`LICENSE`、`CREDITS.md`），
**不含** `preview/`——里面的验收截图截过用户导入的电子书和演讲稿正文，不适合放进公开仓库，已在 `.gitignore` 里排除。

体积与版权说明：`dist/` 约 36 MB，其中词库数据 30 MB（ECDICT / 英语词库，均 MIT，见 `CREDITS.md`）、
字体 5.9 MB（OFL 1.1，许可证随包）。站点自带的示例文章是**本项目原创**；用户导入的书只留在各自浏览器的
IndexedDB 里，不会上传，也不在仓库里。注意：GitHub Pages 是公开的，任何访问者都能下载站内文件——
所以**不要**把自己的书或词库以外的受版权材料提交进仓库。

---

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl / ⌘ + K` | 跳到词库搜索 |
| `Alt / ⌥ + 点击` | 直接看这句话的成分（也可点顶部「成分」模式） |
| `空格` / `Enter` | 复习时翻面 |
| `1` / `2` / `3` | 复习评分：不认识 / 模糊 / 认识 |
| `Esc` | 关闭弹窗；取消选中（词 / 句） |

---

## 目录

```
DeepReadEnglish/
├─ index.html                 应用外壳（三 TAB + 两个弹窗层）
├─ css/
│  ├─ tokens.css             颜色/字体/间距/阴影的设计令牌（唯一来源）
│  ├─ app.css                顶部栏、按钮、文章库、弹窗、设置、词库页、响应式
│  ├─ reader.css             阅读列、正文排版、词级/成分标记、检查器卡片
│  └─ notebook.css           生词本与复习闪卡
├─ js/
│  ├─ core/                  dom · store(localStorage/生词本/SRS) · tts · dict(查词) · quiz(出题/混淆项) · ui · router
│  ├─ engine/                text(段落/句子/单词切分) · pos(词性) · analyze(成分分析)
│  ├─ views/                 card(词卡/句卡) · reader · notebook · dictionary · settings
│  ├─ data/                  exam(考试词库) · dict(兜底) · pos-lex(词性表) · affixes(词缀)
│  └─ app.js                 引导、主题、快捷键、调试接口
├─ tools/                    serve · build-dict · report-dict · build-pos · test-analyze · browser-check · ui-test
├─ docs/                     DICT.md · ANALYSIS.md · QA.md · CREDITS.md
└─ preview/                  Edge 实机截图（browser-check 生成）
```

零构建、零依赖：所有脚本按顺序用 `<script>` 加载，数据是 `window.*` 全局变量，
不使用 `fetch` / ES module，因此 `file://` 双击可用。

---

## 数据与许可

| 数据 / 素材 | 来源 | 许可 |
|---|---|---|
| 六套考试词库（四级/六级/专四/专八/雅思/托福） | [KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary)（经 DSH_learninguse 项目转储） | MIT |
| 音标 / 中文释义 / 词形 / 例句 | [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) | MIT |
| 词根词缀表 | DSH_learninguse 项目整理 | 随项目 |
| 字体 Fraunces / Newsreader / Inter / 霞鹜文楷 | 参考站字体文件（用户授权复用）+ Google Fonts | SIL OFL 1.1 |
| 字体 Literata / JetBrains Mono | [google/fonts](https://github.com/google/fonts) | SIL OFL 1.1 |
| 图标 | 手写内联 SVG | 本项目 |
| 代码与界面 | 本项目原创 | MIT |

词库清洗规则、体积与已知缺口见 [`docs/DICT.md`](docs/DICT.md)；
成分分析规则与已知错误类型见 [`docs/ANALYSIS.md`](docs/ANALYSIS.md)；
许可与致谢全文见 [`docs/CREDITS.md`](docs/CREDITS.md)。

所有数据都在浏览器本机（localStorage），换设备不同步；清缓存会丢失，建议在设置里导出备份。
句子成分分析为规则启发式，不是语言学意义上的准确句法分析，**不要拿它当考试答案**。

---

## 开发与验证

```bash
node tools/serve.js 8787                         # 本地服务器（no-store）
node tools/build-dict.js                         # 重建 exam/dict/affixes（需外部词源路径，见脚本头）
node tools/report-dict.js                        # 词库统计 + 覆盖率 + 抽查
node tools/build-pos.js                          # 重建词性表
node tools/test-analyze.js                       # 成分分析评测（POS / 主干准确率）
node tools/quiz-test.js                          # 复习题库自检（题型 / 选项 / 混淆项 / 性能）
node tools/test-ebook.js [x.epub y.txt]          # 电子书解析（EPUB 元数据/章节、TXT 分章）
node tools/test-import.js [x.epub]               # 真浏览器导入：选文件 → 预览 → 入库 → 分章切换
node tools/test-backup.js [x.epub]               # 备份往返：整本书 + 进度 → 清空 → 恢复
node tools/browser-check.js                      # Edge 实跑 + 截图 + 控制台错误
node tools/ui-test.js                            # 真实交互冒烟（查词/生词本/复习/句析/持久化）
```

测试与截图用 Edge 远程调试端口驱动（Node 内置 WebSocket，不依赖 puppeteer）。
`preview/browser-check.json` 是机器可读报告。

---

## 已知限制

- 复习选择题的干扰项是自动生成的，偶尔会出现生僻但同词性的词。
- 句子成分分析是**规则启发式**：长难句、省略句、倒装、嵌套从句容易标错；置信度低时请只看逐词词性。
  内置 86 句金标回归集是开发中自建并反复迭代过的（POS 97%、主干中心词 100%），**不代表域外任意文章**的
  准确率；README 与 `docs/ANALYSIS.md` 都按「自动推断、仅供参考」对待。
- 词库释义来自 ECDICT，个别生僻词条的中文义项可能偏旧或偏专业；已尽力清洗，但无法保证全对。
- 兜底词典未覆盖的专名 / 生造词只能给出词缀线索。
- 朗读依赖系统语音，音色因系统而异。
- 进度与生词本只存在当前浏览器；`file://` 与 `http://127.0.0.1` 是**两个不同的 origin**，数据互不相通。
- 词库/词性数据约 12 MB（`js/data/`，其中兜底词典与分析词性按需加载），字体文件约 6 MB；
  首次打开需要解析 1–2 秒，之后由浏览器缓存/本地读取。
- 字体全部随站点分发（`assets/fonts/`），离线可用；参考站字体文件经用户授权复用，许可证原文在同一目录 `licenses/`。
