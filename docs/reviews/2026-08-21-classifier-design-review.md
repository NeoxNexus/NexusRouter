# 分类器设计与实现方向评审（2026-08-21）

> 触发：基于 [`docs/plans/classifier-improvements.md`](../plans/classifier-improvements.md) 与 8/20 那批修复后的实际代码，评审分类器的设计方向是否正确。
> 范围：live 链路 = `src/server.ts` → `src/classifier/hybrid.ts`。基线 `npm test` 499/499 绿。
> 方法：读全部 live 链路代码 + 跑真实路由日志（165 条）+ 用当前分类器实测中英文样例矩阵。
>
> **处置状态（同日）**：发现 1~5 已在 ROADMAP 4.1→4.3 修复（D-002），基线 557/557；发现 6（修复后零观测）仍待 4.0 攒日志。本文的实测数据描述的是修复**前**的行为，作为对照基线保留原文。

## 结论

分层级联的方向正确，"先定义准确率、再谈语义"的判断也正确。但实现上有一个结构性缺陷：**所有档位调整都是单向升档，没有任何下调通路**，叠加后使真实 CC 流量几乎恒定落在最高两档 —— 与 D-001 症状同构，只是机制换了（登记为 D-002）。

另外，讨论清单里排在第 3 位的「embedding 分类器替换 Layer 1」方向不成立，理由见「方向判断」。

## 实测发现

### 1. Layer 1 事实上是死代码

`heuristicThreshold = 0.92` 在无关键词路径上不可达。`heuristicClassify` 的置信度上限：

```
base 0.5 + long 0.10 + requiresTools 0.15 + hasSystemPrompt 0.05 = 0.80 < 0.92
```

穷举 24 种（文本 × long × requiresTools）组合，仅 2 种真正返回 `layer: "heuristic"`，其余全部漏到 Layer 3。即线上分类器实为两层：**Layer 0 关键词 + Layer 3「档位 +1」**，中间的启发式评分只贡献了它的 tier 值，置信度门形同虚设。

能过门的两种都需要 `long + requiresTools` 同时成立并叠加到 0.95（200+ 词英文、含代码块）。Layer 1 独占词（`calculate` / `compare` / `evaluate`，Layer 0 词表中没有）同理，短会话下仍然漏到兜底。

### 2. 单向棘轮（D-002 主症状）

三处升档全部叠加，无一处下调：

| 位置            | 条件                            | 效果            |
| :-------------- | :------------------------------ | :-------------- |
| `hybrid.ts:309` | `conversationLength === "long"` | SIMPLE → MEDIUM |
| `hybrid.ts:323` | `requiresTools`                 | 档位 +1         |
| `hybrid.ts:215` | 低置信兜底                      | 档位 +1         |

实测 `"把这个文件的函数改个名"`（一句话改名，应为 SIMPLE/MEDIUM）：

```
long=false requiresTools=false → MEDIUM
long=false requiresTools=true  → COMPLEX
long=true  requiresTools=false → COMPLEX
long=true  requiresTools=true  → REASONING
```

真实日志 `messageCount` 中位数 123（min 1 / max 287），按 `>6 即 long` 推导，**161/165 条恒为 long**。即线上每条至少吃一级升档，SIMPLE 只剩 greeting 与 haiku 后台任务能命中，设计文档里的「事实查询 / 翻译 → SIMPLE」实际落不到。

### 3. reference 规则是反向陷阱

`checkRules` 中 reference 早于 complex 检查且命中即 `return`，而 `继续 / 那个 / 刚才` 是裸词匹配：

```
继续深入分析这个模块的架构设计          → MEDIUM   (reference-pattern)
上面的实现有 bug，重写整个调度器并补齐测试 → MEDIUM   (reference-pattern)
深入分析这个模块的架构设计              → COMPLEX  (complex-keyword)
```

加一个「继续」就把重活降到 MEDIUM。中文续轮几乎必带这些词，故这是高频路径。注：讨论清单条目 1 判断「reference 先于 complex 不影响正确性」，那是在「取全历史」的语境下成立；改为取当前轮后，它变成了当前轮语义被 filler 词遮蔽。

### 4. Layer 0 精度不足，却以 confidence 1.0 短路一切

规则层给 `confidence: 1.0` 并直接 return，任何误伤都无从纠正。实测误伤：

| 输入                                                 | 判定      | 触发词         |
| :--------------------------------------------------- | :-------- | :------------- |
| `Should the derived class override this method?`     | REASONING | `derived`      |
| `this error message is not logical, fix the wording` | REASONING | `logical`      |
| `What's the correct security header for CORS?`       | COMPLEX   | `security`     |
| `where is the architecture doc?`                     | COMPLEX   | `architecture` |
| `深入分析一下这个变量名合适吗`                       | COMPLEX   | `深入分析`     |

讨论清单的整体方案说「规则只保留高精度短路」—— 目标正确，但当前这些规则不是高精度的。

### 5. 长度维度只对英文生效

`heuristicClassify` 用 `prompt.split(/\s+/).length` 数词。中文无空格分词，109 字中文长指令 → `1`。同义中英句实测：

```
中文长指令(109 字, split=1)  → MEDIUM
英文长指令(60 词,  split=57) → COMPLEX
```

讨论清单条目 2 说「长度 ≠ 难度」，更尖锐的问题是**长度只测了一种语言**。（条目 3「中文词表缺失」已由 8/20 提交解决，该条已过期。）

### 6. 修复后零观测 —— 当前无可标注数据

`~/.nexusrouter/logs/` 共 165 条，最新 `2026-08-18T05:51:30Z`，**全部 165 条缺 `promptCharsSanitized` 字段**，即全部产生于 8/20 那批修复之前。其中 164 条 `reason = reasoning-keyword`，正是 `<system-reminder>` 注入污染（164 条共享同一 `promptPreview` 前缀，`messageCount` 从 209 单调爬到 229 —— 一个任务的工具循环）。

已验证修复有效：同一段真实注入文本经 `sanitizeForClassification` 剥离后，`COMPLEX / reasoning-keyword` → `MEDIUM / uncertain-upgrade`。但**修复后未产生任何新日志**。

结论：拿这批日志做标注或调参，等于给已经不存在的行为建基线。「攒修复后流量」是后续所有数据驱动步骤的前置条件，讨论清单的落地顺序里缺了这一步。

## 方向判断

### 赞同

- 级联架构（廉价短路 → 昂贵语义层）。
- 「第一敌人是准确率无定义，不是没有语义」。
- 错误代价非对称，路由器应偏向后悔小的方向。

### 「拿不准升档」需要配封顶，不能只有下限

无条件 `+1` 让该原则退化为「永远最高档」，路由器失去意义。需要预算或封顶，而非只有 floor。

另一个现实约束会改变代价矩阵的形状：live `config.yaml` 四档全是 `claude-opus-*`（SIMPLE→`opus-4-8`、MEDIUM→`opus-4-8-thinking`、COMPLEX→`opus-5`、REASONING→`opus-5-thinking`）。「该强给弱」的质量代价因此很小，真实代价主要是 thinking token 全局多付。定义档位语义时应以此为前提重算。

### embedding 不是绕过标注的捷径

embedding 相似度测的是 **topic**，不是 **difficulty**——「重构这个函数」与「重构整个架构」在向量空间里很近。要从向量读出难度，要么训一个 head（需要标注数据，正是缺的那样东西），要么就是 LLM 判官。**embedding 在标注问题的下游，不是它的替代。**

建议跳过该步：规则 → LLM 判官（`openai-compat.ts` 已实现）。仅当 LLM 层延迟确实不可接受、且已有标注集时，再回来考虑 embedding。

### 任务级路由：反驳讨论清单对它的驳回

讨论清单条目 1 的遗留项以「会引入状态，与无状态分类器设计冲突」为由缓议。该反驳不成立：

- 路由器**已经有状态**：`server.ts` 的 `retryIndexByText` / `retryIndexByAgent` 就是模块级 Map + 窗口逐出。
- 更重要的是，agentic loop 中 `extractClassificationText` 每轮回溯到的是**同一段文本**（日志已证实：164 条同一 preview、messageCount 单调递增）。按任务缓存不是「新增状态」，而是把重复上百次的确定性计算记住一次。

它同时解掉续轮降档，并把 LLM 分类成本从「每请求」摊成「每任务」—— 这是让 Layer 2 真正可用的前提。

## 建议优先级（与讨论清单排序的差异）

讨论清单落地顺序为 ① 攒标注拿基线 → ② 决策策略修正 → ③ embedding 替换 Layer 1 → ④ 修 Layer 2。建议改为：

**第 0 步（零成本，阻塞后续全部）**：挂真实流量攒修复后日志。→ ROADMAP 4.0，🔲 未做

1. **手写回归集**（60~100 条中英文用例，覆盖四档 + 本报告的全部陷阱），接进 `npm test`。不依赖生产数据，且能立刻锁住棘轮与 reference 短路。→ ROADMAP 4.2，✅ 已落地（`src/classifier/tier-regression.test.ts`，53 条）
2. **定义档位语义**：四档还是三档；difficulty 轴与 thinking 轴是否拆开。这是标注的前置条件（taxonomy 未定则标注无从谈起），故必须早于原 ①。→ ROADMAP 4.1，✅ 已落地（[`tier-taxonomy.md`](../plans/tier-taxonomy.md)，结论：保留四档，因其为能力轴 × 思考轴的乘积）
3. **修决策结构**（按 bug 修，不是调参）：Layer 3 升档改为有条件 / 有封顶；Layer 1 置信度门改为可达或直接删除；reference 降级为弱信号；收紧 `derive` / `logical` / `security` / `architecture` 等裸词。→ ROADMAP 4.3，✅ 已落地（另附启发式基线由 SIMPLE 翻转为 MEDIUM、CJK 词数折算）
4. **任务级路由**：最大的结构性杠杆（见上）。→ 🔲 未做
5. **Layer 2 只接边界流量**：到这一步已是「每任务一次调用」，延迟预算充足。→ 🔲 未做

原 ③（embedding）从路线图移除。ROADMAP Phase 4 已按此重写（新增 4.0 攒日志，评测对象由「15 维打分器」改为 `HybridClassifier`）。

## 附带清理项

| 项                                                                | 现状                                                | 影响                                                                                                                                                                              |
| :---------------------------------------------------------------- | :-------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router/` 2546 行 15 维打分器                                 | 仅 `tool-intent.ts` 接线                            | `CLAUDE.md` 写「14 维」、README / ROADMAP / docs 多处写「15 维」，描述的都是死代码。归位决策在 ROADMAP 3.3，文档表述在 3.9                                                        |
| `logUsage`                                                        | 只有定义与 `index.ts` 导出，零调用点，无 usage 日志 | 项目无法量化自己的核心卖点（成本节省），也测不出棘轮多花了多少钱。已并入 ROADMAP 4.6                                                                                              |
| `server.ts:273` 每请求 `JSON.stringify(unified.rawBody)` 估 token | 实测 247KB body 上 0.717 ms/次                      | 自称 <10ms、manifesto 写「毫秒必争」的路径上，可换 `content-length`（O(1)，实测约 5900× 差）。注意该头是 UTF-8 字节数（中文 12058 vs 4058 字符），除数需按语言校准，不可直接 `/4` |
