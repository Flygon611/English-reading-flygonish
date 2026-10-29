# 素材、数据来源与许可

## 站点本身

深读 · DeepRead 的 HTML / CSS / JavaScript / 界面设计 / 交互逻辑均为本项目原创，以 MIT 许可发布。
不含图片素材；字体自托管（SIL OFL 1.1，许可证随站点分发）；不包含第三方运行时库。

站点自带的示例文章《The Quiet Room》为本项目原创，可随代码一起分发。用户导入的电子书、粘贴的文章只保存在各自浏览器的 IndexedDB / localStorage 里，不上传、不进仓库。

本项目的界面与实现**没有复制**参考项目 `Again_PokemonEnglish`（落叶之潮）的代码或视觉资产；
两者是相互独立的站点（那个是故事型英语学习站，这个是纯工具型精读站）。

## 词库数据

### 1. 六套考试词库（四级 / 六级 / 专四 / 专八 / 雅思 / 托福）

- 上游：[KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary)（MIT）
- 本项目使用的转储：`D:\ToolsSoftware\DSH_learninguse\assets\vocab\{cet4,cet6,tem4,tem8,ielts,toefl}.json.gz`
  （同机另一个学习项目的数据快照，原样只读）
- 字段：词头、音标、中文释义、例句、难度；六个库合并时按词头去重并合并标签。

### 2. ECDICT

- 上游：[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)（MIT）
- 本项目使用其 CSV 快照：`D:\ToolsSoftware\DSH_learninguse\tools\cache\vocab_raw\ecdict.csv`
- 用途：
  - 兜底词典的单字词条（约 6 万条）：中文释义、音标、词形变化、词频、
  - 考试词库词条的音标 / 词形变化补全。
- 清洗：剔除 ECDICT 中大量错挂的 `[网络]` / `[医]` / `[计]` 等领域行（DSH 项目的诊断显示这类行占
  53%，大量挂错词），去重义项、保留词性前缀，规则见 `docs/DICT.md`。

### 3. 词根词缀表

- 来源：`D:\ToolsSoftware\DSH_learninguse\assets\dict\affixes.json.gz`（该项目整理撰写）
- 用途：未收录单词的「词缀线索」提示。

## 字体

全部字体以 SIL Open Font License 1.1 随站点自托管，许可证原文见 `assets/fonts/licenses/`。

| 用途 | 字体 | 来源 | 许可 |
|---|---|---|---|
| 标题 / 大字 | Fraunces | Google Fonts（参考站同款，用户明确授权复用） | OFL 1.1 |
| 英文阅读正文（默认） | Newsreader | Google Fonts（参考站同款，用户明确授权复用） | OFL 1.1 |
| 界面 / 音标 | Inter | Google Fonts（参考站同款，用户明确授权复用） | OFL 1.1 |
| 中文译文 | 霞鹜文楷 LXGW WenKai | [lxgw/LxgwWenKai](https://github.com/lxgw/LxgwWenKai)（参考站同款，用户明确授权复用） | OFL 1.1 |
| 备选阅读体 | Literata | [google/fonts](https://github.com/google/fonts) | OFL 1.1 |
| 备选阅读体 | EB Garamond | [google/fonts](https://github.com/google/fonts)（可变字体，含 dlig / hlig / smcp 等 32 个 OpenType 特性） | OFL 1.1 |
| 等宽 / 连字 | JetBrains Mono | [google/fonts](https://github.com/google/fonts) | OFL 1.1 |

字体文件从参考站 `Again_PokemonEnglish/assets/fonts` 复制（用户允许「字体可以照抄」）以及 Google Fonts 仓库下载，
均保留原始许可证；子集缺字时由字体栈中的 Inter / 系统字体兜底。

## 图标

- 手写内联 SVG path，与本项目代码同许可。
- 图标：手写内联 SVG path，与本项目代码同许可。

## 关于「参考站」

用户工作区里的 `Again_PokemonEnglish`（落叶之潮）是另一个独立的英语学习站。
本项目在开发时参考了它的若干工程经验（零构建、`file://` 可用、localStorage、词库清洗思路），
但**没有复用其代码、界面、故事、角色、立绘或视觉资产**。

## 免责

- 词库释义、音标与例句来自上述开源数据，可能存在错误或过时义项；仅供学习参考。
- 句子成分分析为规则推断，可能出错，不构成语法权威解释。
- 本工具为个人学习用途，数据与许可如与上游最新版本有出入，以上游仓库为准。
