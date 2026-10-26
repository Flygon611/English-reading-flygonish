# 深读 DeepRead · 句子成分分析引擎说明（docs/ANALYSIS.md）

> 对应契约：`CONTRACT.md` §4.2（`DR.analyze`）、§3（数据源）。
> 结论先说明：**这是规则启发式分析，不是语法判官。** 目标读者是英语学习者，
> 所以设计上「宁可少标、不要标错」——不确定时 `structure` 留空、`confidence` 压低、
> `summary` 明确写「未能可靠识别主干（自动推断结果仅供参考）」。

---

## 1. 对外 API（契约不变）

```js
DR.analyze.load()        // => Promise：首次调用动态插入 <script src="js/data/pos-lex.js">
DR.analyze.ready()       // => boolean：词性数据是否已装载（装载前 sentence() 抛 Error('not-ready')）
DR.analyze.sentence(text) // => { text, tokens, clauses, summary, structure, notes, confidence }
DR.analyze.legend        // => 14 个成分角色的 id/zh/color/desc
DR.analyze.posZh         // => 14 个词性的中文名
```

- `load()` 只做一件事：注入 `js/data/pos-lex.js`（相对站点根，`file://` 下可用），
  没有 `fetch`、没有 ES module、不联网。
- 页面从站点根打开时脚本路径为 `js/data/pos-lex.js`；UI 先 `await load()` 再调用 `sentence()`。
- `tokens` 与 `DR.text.tokenize(text)` 中的**单词 token 严格一一对应**（数量、顺序、`s/t/e` 完全一致）；
  标点/空白不参与标注，但内部会读标点来判断分句（逗号、分号、破折号、引号）。
- 失败兜底：任何内部异常都会被 `sentence()` 吞掉并返回结构完整的空结果
  （`confidence: 0.05`、`error` 字段说明原因），**绝不把异常抛给 UI**。
- 测试/集成钩子（非契约）：`DR.analyze._installPos(dictOrDR_POS)` 返回装载词条数，
  `DR.analyze._tag(text)` 返回词性数组，`DR.analyze._trace()` 返回最近一次解析的中间结构。

---

## 2. 词性数据 `js/data/pos-lex.js`

| 项 | 说明 |
|---|---|
| 形状 | `window.DR_POS = { v:1, w:{ 'word':'noun', ... } }`（契约 §4.2） |
| 规模 | 211,088 词条，3.88 MB（上限 5 MB）✅ |
| 生成 | `node tools/build-pos.js`（可重复重建；超 5 MB 会自动把低频词裁掉） |
| 数据源 | ① `DSH_learninguse/tools/cache/vocab_raw/ecdict.csv`（ECDICT，MIT）：WordNet 定义前缀 `n./v./a./s./r.`、中文释义前缀 `n./vt./vi./adj./adv./prep./pron./conj./num./art./aux.…`、`exchange` 屈折形式、`bnc/frq` 频次；② `kaikki-en-extract.json`（Wiktionary 抽取，用于校正高频词） |
| 屈折形式 | 收录 5 万条 `p:/d:/i:/3:/s:/r:/t:` 形式（`deliberating`、`reached`、`tastes` …） |

### 2.1 一个内部约定：多词性编码

契约要求每个词给**一个**主词性。但英语里 `report/run/exercise/skill/tastes` 这类词
名词/动词都常见，只存一个会让上下文规则无从选择。因此本表的值允许写成
`"verb|noun"`（主词性在前，第二候选在后，只保留第二候选投票 ≥ 主候选 45% 的实词）。
`pos.js` 读取时取第一段作主词性，并按上下文在候选间切换；**`{v, w}` 的字段形状没有变**，
外部只读 `w[word].split('|')[0]` 也完全兼容。`docs` 在此明确记录，避免误解。

### 2.2 功能词在代码里维护

冠词、介词、连词、代词、助动词、情态动词、否定词、数词、常见系动词、双宾语动词、
抽象名词（`fact/idea/…`）、不规则过去式/过去分词等，写在 `js/engine/pos.js` 的表里，
比语料更可靠，也便于解释。

---

## 3. 分析流水线

```
输入 text
  └─ DR.text.tokenize(text)                  ← 冻结的唯一 tokenizer
      └─ 单词 token + 标点信息（逗号/分号/破折号）
          └─ DR.pos.tag(words)               ← 词性标注（功能词表 + 词典候选 + 上下文改写）
              └─ 分句划分（顶层并列 + 嵌套从句 + 插入语）
                  └─ 主句主干：主语 / 谓语 / 宾语 / 表语
                      └─ 嵌套从句内部粗标（关系词=rel、引导词=mark、内部主谓宾）
                          └─ 语法点 notes
                              └─ summary + confidence
```

### 3.1 词性标注（`js/engine/pos.js`）

1. **基础标注**：功能词表 → 词典 `DR_POS`（含 `"a|b"` 候选）→ 词形兜底
   （`-ly→adv`、`-ing/-ed→verb`、`-tion/-ment→noun`、`-ous/-ful→adj` 等）。
2. **上下文解析**：`that` 的四解（限定词/关系代词/名词性从句连词/同位语从句连词）、
   `to`（不定式标记 vs 介词）、`as/than/before/after/since/while`（连词 vs 介词）、
   `which/whose`（先行词在前 → 关系代词）、`no/either/neither`、`one`、`there`。
3. **改写规则（三遍，正反各一次）**：
   - 冠词/数词/形容词后的动词 → 名词（`the run`、`a rare skill`）；
   - 情态动词 / 助动词 `do` / 不定式 `to` 后 → 动词；
   - 主语代词后 → 动词（`who lives`、`he left`、`she failed`）；
   - `be/have/being/having` + `-ing/-ed/不规则分词` → 动词（`was written`、`having finished`）；
   - 名词+不规则过去式 → 动词（`the news made everyone`）；
   - 名词+副词/介词/句末 → 动词（`whose son studies abroad`、`works at`）；
   - 冠词 + X + 名词 → X 取形容词候选（`a young scientist`）；
   - 句中大写词 → 专有名词（`Sunday`、`April`）；
   - 高频副词表（`ago/out/home/never/…`）纠偏。

词性约定（写进注解与金标）：
- `not` = `adv`；不定式 `to` = `part`，介词 `to` = `prep`；
- `when/where/why/how` = `adv`（关系副词同）；
- 序数词 = `adj`，基数词 = `num`；
- 存在句 `there` = `pron`；物主词在名词前 = `det`，独立使用 = `pron`；
- 被动/完成里的 `be/have` = `aux`；`be + 表语`里的 `be` = `verb`。

### 3.2 分句

- **顶层并列**：`and/or/but/nor/yet/so` 或分号后，若前段已有谓语且后段有「主语 + 有限动词」，
  切成兄弟分句（`type:'coord'`，label「并列句」）；`John and Mary went` 这种并列主语不切。
- **定语从句**：`who/whom/whose/which/that/where/when` 前有先行词（且不在段首）；
  也识别**省略关系词**（`the people we met`）。结束位置：关系从句动词之后的**下一个有限动词**
  或紧随的逗号。
- **状语从句 / 名词性从句**：`because/although/if/when/while/since/until/as/…`、
  `that/whether/what/who/if`；名词性从句判定看位置（段首作主语、动词/介词后作宾语、
  抽象名词后作同位语从句）。结束位置：第一个有限动词组之后，遇逗号+新主句主语、
  或下一个有限动词（主句倒装时不回吞主语）。
- **非谓语短语**：句首 `To do …, / Having done …, / Determined to …,`；
  逗号之间的插入分词（`The students, excited by the news, rushed`）作为嵌套 nonfinite，
  不参与主句谓语竞争。
- **主句解析时一律跳过嵌套从句内部**（`findFiniteGroup` 跳过嵌套 span），
  这是「主句谓词被从句抢走」问题的根因修复。

### 3.3 主干

1. 跳过句首引导词/嵌套从句/前置状语（副词、介词短语）与非谓语短语。
2. 找**第一个有限动词组**：`aux/modal/(not)/主谓动词` 链，链中最后一个实义动词是谓语中心词；
   `be + 过去分词` 是被动谓语。
3. 疑问/倒装（`Do you know…`、`Why did the company close…`、`Never have I seen…`、
   `Only after …, did he realize…`）：助动词/情态动词在前，主语在其后，再到实义动词。
4. 主语 = 第一个有限动词组之前（去掉嵌套从句、插入语、两端副词）。
5. 谓语后成分：
   - 系动词（`be/become/seem/appear/remain/stay/feel/look/sound/taste/smell/prove/keep`）
     → 表语（NP / AdjP / PP）；
   - 及物动词 → 第一个 NP 作宾语；**双宾语动词**（`give/tell/show/teach/offer/…`）才收第二个宾语；
   - 额外 NP 默认作状语（`last month`、`every day`、`five years ago`），时间类 NP 用
     `next/last/this/every + year/month/day…` 判定；
   - 非谓语（`to do / doing / done / 裸不定式`）整体标 `nonfin`，其内部宾语不写入主干；
   - 介词短语按状语处理（内部介词 `prep`、其余 `adv`）。
6. `there be`：`there` 空角色 + `be` 谓语 + be 后 NP 为主语（notes 说明）。
   `It is + adj + to do/that …`：`it` 空角色 + 形式主语 note。
7. `structure` 只放**可靠**的主干成分（subj/pred/obj/comp，按句序，带 char 偏移与原文）。

### 3.4 语法点 notes（kind 稳定取值）

`passive` 被动、`perfect` 完成时、`progressive` 进行时、`modal` 情态、
`nonfinite-infinitive` 不定式、`nonfinite-participle` 分词、`nonfinite-gerund` 动名词、
`relative` 定语从句、`noun-clause` 名词性从句、`adverb-clause` 状语从句、
`coordinated` 并列、`inversion` 倒装、`expletive-it` 形式主语、`existential-there` there be、
`appositive` 同位语、`comparative` 比较、`ellipsis` 省略（如省略关系词）、`other` 其他。

### 3.5 置信度 `confidence`

置信度来自**证据强度**，不是「句子长短」：

| 区间 | 含义 | 依据 |
|---|---|---|
| ≥ 0.85 | 较高 | 主句有唯一、明确的有限动词组 + 主语边界清晰 + 无未隔离的从句/多个候选谓词 |
| 0.60–0.85 | 中等 | 主干成立，但含从句/倒装/非谓语，或从句层数多、句子长 |
| 0.45–0.60 | 较低 | 存在多个有限动词候选、未知词比例高、或结构依赖启发式推断 |
| ≤ 0.45 | 低 | **主干不可靠**：找不到可靠谓语/主语、多动词未隔离、花园路径等；此时 `structure` 为空、`summary` 写「未能可靠识别主干」 |
| 0.05 | 兜底 | 空串/纯标点/内部异常 |

具体扣分：每个嵌套从句 −0.03（上限 −0.2）、长度 >32 词 −0.06、未知词 >35% −0.1、
多有限动词候选 −0.08、找不到谓语则封顶 0.45。UI 用「较高/中等/较低」展示即可。

---

## 4. 评测：`node tools/test-analyze.js`

金标：`tools/gold-sentences.json`，**94 句**人工标注（94 句 = 初版 80 句 + Lead 回归 6 句 + 真实文章抽测回归 8 句），
覆盖简单句 / 主系表 / 被动 / 定语从句（含省略关系词）/ 状语从句 / 名词性从句 / 非谓语 /
并列 / There be / 形式主语 / 疑问 / 祈使 / 比较 / 长难句。每句标：
- `pos[]`：按语境逐 token 词性；
- `roles[]`：主干成分（subj/pred/obj/comp/aux），其余留空。

评测口径（与 Lead 对齐，避免「约定差异」被当成错误）：

| 指标 | 口径 |
|---|---|
| POS 准确率 | 逐 token 比较语境词性 |
| 主干中心词准确率 | 每个 gold 成分（同角色连续 token 段）的中心词角色是否正确（主目标） |
| 主干成分边界准确率 | `structure` 里是否存在与 gold 成分同角色、同首尾 char 跨度的条目 |
| 短语内部标注可接受率 | 宽松逐 token：短语内部非中心词标成 det/attr/adv/prep/aux/nonfin/appos 等都算对 |
| 过度标注 | 主句内被标成骨架、但 gold 没有且不在嵌套从句里的 token（真问题指标） |
| 完全正确句子 | 中心词 + 边界全对且主句无过度标注 |

当前结果（本机 Node，数据见命令输出）：POS 总体 **97.9%**（简单句 98.0%）；
主干中心词 **100%**；成分边界 **100%**；过度标注 **0**；完全正确 **94/94**；
单句平均 0.1 ms、最大 <2 ms（目标 <20 ms）。

**诚实的说明**：金标语料是固定 94 句，引擎在开发中针对它迭代过，
所以上面是「回归集上的成绩」，不代表任意真实文章都有同样的准确率；
域外长难句、花园路径句、省略句的错误率会明显更高（见第 6 节）。
金标里有几处人工笔误（下标错位）在评测过程中被修正，已如实记录在本文件与提交说明中。

退化输入（空串、纯标点、全大写、引号破折号、超长、无动词 NP）由测试脚本覆盖：
不抛异常、tokens 与 tokenizer 对齐、confidence 低。

复跑：

```bash
node tools/build-pos.js      # 需要时重建词性表（读 ECDICT / kaikki，只读源数据）
node tools/test-analyze.js   # 评测；--verbose 打印每句 pos/role/summary
```

### 4.1 真实文章回归（`DR.reader.sample`《The Quiet Room》16 句）

Lead 用真实文章抽测后补充的回归集（8 句进 gold，其余作为边界检查）：

| 句 | 期望主干 | 当前输出 |
|---|---|---|
| When I first began to read seriously, I treated every book as a test. | I + treated + every book（when 状语从句） | ✔ 同左，conf 0.87 |
| I underlined …, copied …, and promised myself that … | I + 并列谓语 ×3 + 宾语 | ✔ 同左，conf 0.79 |
| Usually I did not. | I + did | ✔ 同左，conf 0.90 |
| It tells you which meaning …, what tone …, and why … | It + tells + you + 名词性从句 ×3 | ✔ 主谓宾，clauses 识别 2 个最外层，conf 0.84 |
| Eventually I discovered that a word learned … stays with you … | I + discovered + that 宾语从句 | ✔ 同左，conf 0.84 |
| A definition you have to look up three times is not yet yours; a word … is beginning to be. | 两个分句各自主谓 | ✔ 同左，conf 0.76 |
| Put the coat …, pick a paragraph, and begin. | 祈使句 + 并列谓语 ×3 | ✔ 同左，conf 0.82 |
| Coats go …, bags are placed …, and the only sounds are … | 三个并列分句 | ✔ 三个分句主干，conf 0.76 |

16 句全部有主干（0 句回落为「未能可靠识别主干」）。局限：第 8 句的并列表语只收第一个 NP。

---

## 5. 性能与体积

- 单句分析：平均 ~0.1 ms，最长 <2.5 ms（94 句语料，Node）。
- `pos-lex.js`：3.88 MB（≤5 MB 契约要求）；页面首屏不加载，`DR.analyze.load()` 时才注入。
- 分析引擎纯函数，无 DOM 依赖（仅 `load()` 用 DOM 注入脚本），不联网。

---

## 6. 已知错误类型与局限（主动声明）

1. **主句谓词竞争**：多从句嵌套、连续名词短语堆叠时仍可能选错；已用「嵌套 span 跳过 +
   多候选检测」降低，但无法穷尽。真实文章抽测暴露的几类已修：句首状语从句回主句、
   逗号/and 连接的并列谓语共享主语、that/wh- 宾语从句延伸、祈使句、`Usually I did not.` 这类省略。
2. **花园路径句**：`The horse raced past the barn fell.` 这类句子会被判为不可靠（confidence ≤0.45），
   不会给出错误主干——这是有意为之。
3. **名词性从句作主语**：`That the plan failed was obvious.` 只给「（主语从句）+ 谓语 + 表语」，
   主语从句不作为 `structure.subj` 的 span 出现（避免把整段从句当成主语短语）。
4. **`it` 强调句/cleft**：`It is the ability to adapt that matters most.` 会按「主系表」输出，
   `that` 从句不进主干；会给出 `expletive-it`/`relative` note，但不是严格句法树。
5. **`that` 的双解**：`the fact that he came`（同位语/名词性从句）与
   `the report that the committee released`（定语从句）靠抽象名词表 + 结构启发式区分，会错。
6. **名词性从句、并列 VP、省略句**：`What matters is …` 这类双名词性从句对比结构只给低置信度
   （≤0.45、structure 留空）；`tells you which…, what…, and why…` 三个并列从句只把最外层算进
   clauses，主句主干仍正确。
7. **词性歧义**：`-ing/-ed`（分词 vs 形容词 vs 动名词）、`report/run/skill` 类名动同形、
   `that/which`、`no/any` 等依赖上下文规则，仍会有错；短语动词的小品词（`look up` 的 up：
   金标按副词，引擎偶尔给介词）也属于这一类。
8. **短语动词/搭配**：`look after`、`take off`、`depend on` 的小品词/介词不单独建模。
9. **冠词性**：`the union` 这类大写/专名歧义、`Sunday/April` 之外的专有名词识别靠大写。
10. **没有指代消解**：`it/they/this` 指代什么不做推断，UI 也不应暗示做了。
11. **it 强调句（cleft）**：`It is the ability to adapt that matters most.` 会按「主系表」输出
    （subj It / pred is / comp the ability），that 从句只进 clauses / notes，不是严格句法树。
12. **列表型表语**：`the only sounds are the turning of pages, an occasional cough, and …`
    只把第一个 NP 进 structure.comp，后面并列项不进主干（低风险，不影响主谓）。

遇到不确定时引擎会主动降级（清空 `structure`、`confidence ≤0.45`、`summary` 明示），
这是本模块最重要的质量约定：**宁可少标，不要标错**。

---

## 7. 文件清单（parser-engine 作用域）

| 文件 | 作用 |
|---|---|
| `js/engine/pos.js` | 词性标注：功能词表、词典候选、词形与上下文规则；`load()` 动态注入词性表 |
| `js/engine/analyze.js` | `DR.analyze`：分句、主干、notes、summary、confidence |
| `js/data/pos-lex.js` | `window.DR_POS`（由 `tools/build-pos.js` 生成，可重建） |
| `tools/build-pos.js` | 从 ECDICT + kaikki 生成词性表（只读源数据，不修改） |
| `tools/test-analyze.js` | 金标语料评测 + 契约不变量 + 性能 + 退化输入 |
| `tools/gold-sentences.json` | 94 句人工标注金标语料（含 `reader.sample` 真实文章 16 句中的 8 句回归） |
| `docs/ANALYSIS.md` | 本文件 |
