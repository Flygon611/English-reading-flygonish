# 深读 DeepRead · 词库数据说明（docs/DICT.md）

本文件说明站点本地词库的来源、清洗规则、体积与已知缺口。
所有数据文件都由 `node tools/build-dict.js` **从源数据重建**，请勿手改生成物。

---

## 1. 产物清单

| 文件 | 全局变量 | 条数 | 体积 | 契约 |
|---|---|---|---|---|
| `js/data/exam.js` | `window.DR_EXAM` | **16,638** | **2,925 KB**（2,995,023 字节） | ≤5 MB（Lead 追加 ≤4.5 MB）✓ |
| `js/data/dict.js` | `window.DR_DICT` | **60,000** | **4,724 KB**（4,837,585 字节） | ≤6 MB ✓ |
| `js/data/affixes.js` | `window.DR_AFFIX` | **202** | **20 KB**（20,926 字节） | 契约 §3.3 ✓ |
| 合计 | — | — | **7,669 KB**（7,853,534 字节） | ≤11 MB ✓ |

- 编码：UTF-8 **无 BOM**，仅 LF 换行，每个文件末尾有换行。
- 格式：经典 `<script>` 可加载；Node 里 `global.window = {}; require('./js/data/exam.js')` 后可从 `window.DR_EXAM` 取到。
- 写入方式：先写 `<name>.js.tmp` 再 `rename`（原子替换），页面/验收脚本不会读到半截文件。
- 构建可重跑且**确定**：同一份源数据多次构建产物的 SHA-256 完全一致（exam `fa5e15bd…`、dict `708430ee…`、affixes `3c3c619d…`）。

### 字段（与 CONTRACT.md §3 完全一致）

```js
window.DR_EXAM  = { v:1, packs:{cet4:'四级',...}, words:[ [word, ipa, zh, ex, exZh, mask, lvl, forms], ... ] };
window.DR_DICT  = { v:1, words:[ [word, ipa, zh, mask, forms, rank], ... ] };
window.DR_AFFIX = { v:1, items:[ { a, type, zh, ex:[], note }, ... ] };
```

`mask`：exam 六位（1 四级、2 六级、4 专四、8 专八、16 雅思、32 托福）；dict 四位（1/2/16/32）。
`lvl`：exam 难度 1–4；`rank`：dict 频次序（0 = 未知）；`forms`：空格分隔屈折形式，≤8。

---

## 2. 数据来源与许可

| 数据 | 来源 | 许可 |
|---|---|---|
| 六套考试词库 `assets/vocab/{cet4,cet6,tem4,tem8,ielts,toefl}.json.gz` | KyleBing/english-vocabulary + ECDICT，经 `DSH_learninguse` 整理 | MIT |
| `ecdict.csv`（770,611 行） | skywind3000/ECDICT | MIT |
| `affixes.json.gz`（202 条前后缀/词根） | DSH_learninguse 整理 | 随项目 |

构建期只读这些文件，**不修改源数据、不联网、不引入 npm 依赖**（仅 Node 内置 fs/path/zlib）。

---

## 3. 构建与校验

```bash
node tools/build-dict.js      # 从源数据重建三个数据文件（约 4 秒，读 66MB CSV）
node tools/report-dict.js     # 验收报告：条数/体积/mask 分布/覆盖率/20 词抽查/结构自检
```

`build-dict.js` 支持 `--src <DSH_learninguse 根目录>` 覆盖源路径。
`report-dict.js` 用**与实际运行期相同**的代码路径统计覆盖率：`js/engine/text.js` 切词 +
`js/core/dict.js` 的 `DR.dict.lookup`（exact → forms 反查 → 后缀还原），退出码 1 表示有失败项。

---

## 4. 清洗规则

### 4.1 exam（六套考试词库合并）

1. 六套库按 `w` 小写去重合并；`mask` 按来源位累加。
2. `zh`：把每条的 `t` 与 `d[]` 逐行拆开 →
   - 丢掉领域行（`[网络]`/`[医]`/`[计]`/`[化]`… ）与纯英文残渣；
   - 一行里塞了多个词性的（如 `n. 放任；狂热 v. 遗弃；放弃`）、以及词性连写（`vt.vi.`、`aux. v&vi`、`ad&prep.`）会被切成独立词性块；
   - 按词性归组：**n → v → adj → adv → 其他**（其余按首次出现顺序）；同词性内用 `；` 分隔义项，词性组之间用**两个空格**；
   - 义项去重：去空白/标点/全半角差异后比较核心串；近似重复（一个是另一个前缀且长度差 <6）只留长的；跨词性重复的义项只保留一次；
   - 垃圾片段剔除（Lead 指定 + 实测）：`auxiliary verb`、`sb与`、`sth在`、`在缺少`、`的情况下`、纯英文小写残句、首字母小写且以 `.` 结尾的半句、`(Be)人名`/`(缅)拜` 这类专名音译注记、括号不配对的行、动词变位表注记（`过去式gendered…`）等；
   - 每条 `zh` ≤ **110 字符**（契约上限 160），实际最长 92 字符。
3. `ipa`：取源库第一个非空音标；`ә`(Cyrillic)→`ə`、`'`→`ˈ`、`:`→`ː`、词首/音节前 `,`/`.`→`ˌ`、`ˊ`→`ˈ`，多读法只保留第一读法，去掉转义残渣。
4. `ex`/`exZh`：从各来源里挑**完整英文句子**（句首大写/引号开头 + 句末标点 + 无粘连词），优先带中译；不足的留空（宁可没有例句，也不放碎片）。
5. `lvl`：源库 `lvl` 是 1–5 的全局难度（同一词在六套库里一致），按契约压到 1–4：`min(4, 源lvl)`。
6. `forms`：由 ECDICT `exchange` 双向反查（本词 `p/d/i/3/r/t/s` 值 + 其它词条 `0:` 指向本词），去自身、≤8 个。

### 4.2 dict（ECDICT 兜底词典）

1. 选词：单字词（无空格）、`word` 只含字母/撇号/连字符、**忽略大小写唯一**、`translation` 清洗后非空；
   规则 = `tag` 非空 ∪ `collins>0` ∪ `oxford=1` ∪ `bnc>0` ∪ `frq>0`。
2. **排除 `DR_EXAM` 已有词**（重叠 0 条，`report-dict.js` 每次校验）。
3. `zh`：与 exam 同一套释义管线（剔领域行、切词性块、去重、垃圾片段过滤、词性组序 n→v→adj→adv→其他、组间两个空格），≤110 字符（契约上限 120）。
4. `mask`：由 ECDICT `tag` 映射，`cet4→1`、`cet6→2`、`ielts→16`、`toefl→32`，无则 0。
5. `rank`：`bnc`/`frq` 取较小非零值，都没有则 0。
6. `forms`：与 exam 同一套 exchange 反查；仅 `rank ≤ 20000` 的词给词形（其余靠后缀规则还原），省体积。
7. 排序：严格池按 `rank` 升序（0 最后），补足池排在其后；按顺序装填至 6 MB 上限为止（先保高频，绝不丢 `the`/`a`/`of` 这类词——它们在 exam 里）。

### 4.3 affixes

`affixes.json.gz` 的 `affixes[]` 原样映射为 `{a, type, zh, ex, note}`（note 缺失补 `''`），`v:1`。

---

## 5. 统计

- **exam 各包源词数**：四级 4,544 / 六级 3,991 / 专四 4,340 / 专八 12,410 / 雅思 5,274 / 托福 10,366（合计 40,925 条，合并去重后 16,638 条）。
- **exam mask 分布**（按位计数）：四级 4,544 / 六级 3,989 / 专四 4,337 / 专八 12,399 / 雅思 5,270 / 托福 10,349；多选 10,111 条；无 mask 0 条。
- **exam 质量**：有音标 16,449 / 16,638（99%）、有例句 11,604（69.7%）、有词形 11,395（68.5%）；释义最长 92 字符、无 >110 字符条目。
- **dict**：60,000 条（严格选词池 38,026 条 + 补足池 21,974 条）；有音标 51,178；有词形 3,248；mask 非 0 共 1,211 条。
- **dict mask 分布**（按位计数）：四级 25 / 六级 57 / 雅思 408 / 托福 705；无 mask 58,845。四级/六级数字小是因为与 exam 重叠的常考词按契约不重复收录。

> **关于 dict 的 60k 条**：严格按契约 §3.2 的选词规则，全库只有 54,025 条候选，去掉与 exam 重叠的 15,999 条后只剩 **38,026 条**——契约目标 50k–90k 在该规则下**无法达到**。
> 因此补足池收录 ECDICT 中「有音标 + 清洗后中文释义、但 BNC/COCA 频次序为 0」的词条，按「非屈折变形 → 连字符复合词 → 有 exchange → 义项丰富度」排序，用于覆盖普通文章里的低频词；它们 `rank=0`，在排序上永远位于严格池之后，不影响高频词。补足池同样过全部清洗与去重，不引入乱码/领域行。

---

## 6. 覆盖率（契约 §3.4）

`node tools/report-dict.js` 实测（与实际运行期相同的 lookup 路径）：

| 样本 | 命中/总数 | 覆盖率 |
|---|---|---|
| 1. It was a bright cold day in April… | 14/14 | 100% |
| 2. The committee, which had been deliberating… | 23/23 | 100% |
| 3. Scientists have discovered that the deep-sea creature… | 18/18 | 100% |
| **合计** | **55/55** | **100.00%**（目标 ≥98%） |

命中方式：exact 47 / forms 反查 7 / 后缀还原 1。功能词 `the / of / and / to / be / have / will` 全部可查（exam）。
生僻词如 `deep-sea` 由 dict 收录；屈折形式（`deliberating`、`clocks`、`were` 等）由 forms 反查或后缀规则还原。

**附加语料压测**（非契约要求，仅作参考）：用 `cet4/cet6/ielts` 的 284,407 个例句 token 跑同一 lookup 路径，
覆盖 **99.50%**。未覆盖的主要是专有名词（Robert/Alice/Ledley/Ying/Boerne/Mexicali…）、少数连字符复合词
（high-speed/air-pollution/peacekeeping）与数字后缀 token（`1990s`→`s`、`1st`→`st`）；纯词条缺口很少。
所有格（`children’s` 等）已由 `js/core/dict.js` 的 possessive 规则还原。

---

## 7. 20 词抽查（节选，完整输出见 `node tools/report-dict.js`）

| 词 | 词头 | 来源 | 释义（zh） | 词形 |
|---|---|---|---|---|
| deliberate | deliberate | exam | v. 仔细考虑；思考；商议  adj. 故意的；蓄意的；慎重的 | deliberating deliberated deliberates |
| ubiquitous | ubiquitous | exam | adj. 无处无在的；普遍的；普遍存在的 | — |
| abandon | abandon | exam | n. 放任；纵情；狂热  v. 丢弃；放弃；抛弃 | abandoned abandoning abandons |
| be | be | exam | v. 是；有；存在  aux. 在；做 | was is been being |
| go | go | exam | n. 去；进行；尝试  v. 走；变为；达到 | going went gone goes |
| committee | committee | exam | n. 委员会；全体委员 | committees |
| scrutinize | scrutinize | exam | v. 仔细检查；细察 | scrutinized scrutinizing scrutinizes |
| the / of / and / to / have / will | — | exam | 见报告；功能词全部可查 | — |
| went | go | exam（via=lemma） | 走（go 的过去式） | — |
| children | children | dict | 孩子们 | — |
| left | left | exam | n. 左边；左派；激进分子  v. 离开（leave的过去式）  adj. 左边的；左派的 | — |

所有 exam 抽查词的 `mask` 都与六套源包实时计算的 bits 一致（`report-dict.js` 自动对照并打 `mask✓`）。

---

## 8. 已知缺口与限制（如实记录）

1. **exam 有 16 条源库自带的多词短语**（如 `in comparison with`、`vice versa`、`at random`）。点词查词按单个单词命中，这些短语不会被点到；保留它们只是为了「exam 覆盖六套库全部词」，共约 1 KB。若 UI 不希望显示，可在 `js/core/dict.js` 的 exam 索引里过滤 `/\s/`（数据侧不建议删，以免偏离「覆盖全部词」）。
2. **exam 有 1,034 条无例句**：源库没有例句，或例句是碎片（首字母小写、截断、粘连词）被本轮清洗拒绝。契约允许 `ex=''`，UI 需容忍空例句。
3. **释义已截断**：exam ≤110 字符（最多每词性 3 个义项、合计 6 个）、dict ≤110 字符；极多义项的词只保留前几个义项，不追求全义项覆盖。
4. **部分专名义项保留**：源数据把姓名/地名注记混在中文释义里（如 `at` 的「阿特（老挝货币基本单位）」「砹」、`am` 的调幅缩写）。已清掉展开式专名注记（`(Be)人名；(缅)拜`），但单个专名义项未完全剔除——它们本身是真实义项，不是错挂。
5. **音标只保留第一读法**，且 ECDICT 源本身存在少量不规范拼写（已做 `ә→ə / '→ˈ / :→ː / , .→ˌ` 归一）。个别词音标仍不理想（例如 `and` 在源数据里就是 `ənd, ən, ænd`，取第一读法后为 `ənd`）。
6. **ECDICT 的 `[网络]/[医]/[计]` 领域行全部剔除**（契约要求）。已按 `DSH_learninguse/tools/ecdict_clean.py` 的诊断结论执行：这些领域行大量错挂（heroine←heroin、throughout←throughput、syllable←byte 等），剔除比保留正确。
7. **未收录**：运行期不联网，不覆盖全部英语词汇（约 60k 兜底 + 16.6k 考试词）；极低频/专业词、纯粹的人名地名、以及非 ASCII 词头不收。
8. **`forms` 只对高频段词条给出**（dict 中 rank > 20000 的词 `forms=''`）；其余屈折形式由 `DR.dict` 的后缀规则还原（如 `-s/-es/-ed/-ing/-er/-est/-ies/-ied`）。
9. **所有格 `'s` 由运行期 `js/core/dict.js` 还原（已验证）**：tokenizer 会把 `children’s` 切成一个整 token，
   `DR.dict.lookup` 里已加 possessive 规则，实测 `children’s→children`、`government’s→government`、`notebook’s→notebook`
   均返回 `via='possessive'`；`dogs’` 因 tokenizer 不含尾部撇号，直接命中 `dogs`。数据里不收录 `children's` 这类词条。
   另：`1990s` / `1st` 这类数字后缀会被 tokenizer 切出 `s` / `st` 单 token，属于 tokenizer 的已知行为，UI 侧可跳过长度 <2 的 token 查词。
