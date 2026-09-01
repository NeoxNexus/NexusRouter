# 分类器改进讨论清单（防止发散遗漏）

> 起源：2026-08-19 关于"当前路由规则是否足够、是否过于粗放"的讨论。
> 范围：live 链路 = `src/server.ts` → `src/classifier/hybrid.ts`（`src/router/` 的 15 维 sigmoid 打分器未接线，不在本清单内）。
> 2026-08-21：条目 2~6 讨论完毕，优先级已修订。实测依据见 [设计评审报告](../reviews/2026-08-21-classifier-design-review.md)。
> 下方「整体方案讨论」「发散讨论」两节保留 8/19 原文作为决策轨迹，其中 embedding 主力方向已于 8/21 撤销。

## 已识别的粗放点（ backlog ）

> 状态标注见「逐条讨论进度」。✅ = 已修复；⚠️ = 讨论后确认仍存在。

1. ✅ **分类输入是全部历史 user 消息拼接**（`server.ts:84`）→ 长会话词数虚增顶到 COMPLEX；历史关键词污染当前轮
2. ✅ **Layer 1 本质是数词数**（>200 词 COMPLEX / >50 MEDIUM），长度 ≠ 难度 —— 4.3 已改：CJK 词数折算 + 基线翻转为 MEDIUM，长度不再是唯一档位来源
3. ✅ **关键词表英文中心**：reasoning/complex 词表纯英文，`\b` 对中文无效（`hybrid.ts:46` 自认）；中文"证明/推导/分析架构"miss
4. ✅ **Layer 2 语义层形同虚设**：`ollama.enabled` 默认 false，且默认模型名 `qwen3.5:2b/4b` 在 Ollama 注册表不存在
5. ✅ **无上下文长度护栏**：live 链路不看 token 量，大上下文可能路由到小窗口便宜模型；tier `fallback` 列表未接线（`server.ts:135` 只取 primary）
6. ⚠️ **小问题**：`server.ts:324` 注释 "Force SIMPLE" 与融合数学不符（分类器给 REASONING 时后台任务实际落 MEDIUM）；`server.ts:39` 注释 "15-dim classifier" 过时（实际是 HybridClassifier）—— 两处注释已不在 `server.ts`，但 docs 的「15 维」表述仍待 ROADMAP 3.9 收口

## 逐条讨论进度

### 条目 1：全历史 vs 当前轮 —— 讨论完毕，已落地 ✅（`6cdf733`）

讨论结论：

- "复杂任务后回复'继续'被路由到 SIMPLE"的场景不存在：Layer 0 reference 模式（`/继续/`）对当前轮直接命中 → MEDIUM（conf 1.0），与是否取历史无关。实际风险是 MEDIUM vs COMPLEX 的降档，不是 SIMPLE。
- 全历史并没有保护该场景：`checkRules` 中 reference 先于 complex 检查，"继续"命中后直接 return，历史中的复杂关键词不生效。
- **真正的坑**：CC agentic loop 每次工具回调产生 tool_result-only 的 user 消息，`extractText`（`anthropic.ts:46`）丢弃该块 → 文本为空。naive 的"只取当前轮"会让每个工具回调轮落入空文本兜底 → SIMPLE，复杂任务中途全程降档。
- **最终方案**：取"最近一条含真实用户文本的消息"——从最新 user 消息往回跳过剥离后为空的（tool_result-only），用第一条非空的做分类。历史污染与续轮降档同时解决。

后续遗留（单独讨论）：会话级 tier 记忆——continuation 轮继承上一轮非 SIMPLE 档位做下限（可衰减）。会引入状态，与无状态分类器设计有冲突，待议。**→ 2026-08-21 该缓议已撤销，见下方「修订：任务级 tier 记忆不再缓议」。**

另注：本条结论中「reference 先于 complex 检查不影响正确性」只在「取全历史」语境下成立。改为取当前轮后，它变成当前轮语义被 filler 词遮蔽的缺陷（见条目 2~6 的 D-002 段）。

### 条目 2~6：讨论完毕 ✅（2026-08-21）

逐条结论（实测依据见 [设计评审报告](../reviews/2026-08-21-classifier-design-review.md)）：

- **条目 2（Layer 1 数词数）**：问题比「长度 ≠ 难度」更重 —— ① 长度只对英文生效（`split(/\s+/)` 对 109 字中文返回 1，中英同义句实测 MEDIUM vs COMPLEX）；② `heuristicThreshold = 0.92` 在无关键词路径上不可达（上限 0.5+0.1+0.15+0.05 = 0.8），穷举 24 种组合仅 2 种真走 `layer: "heuristic"`，**Layer 1 事实上是死代码**，线上实为「Layer 0 关键词 + Layer 3 档位 +1」两层。
- **条目 3（关键词表英文中心）**：**已过期** —— 8/20 提交（`4e22796`）已补中英双通路词表。但暴露了新问题：Layer 0 以 `confidence: 1.0` 短路一切，而这些规则并非高精度（`derived class` → REASONING、`where is the architecture doc?` → COMPLEX、`深入分析一下这个变量名合适吗` → COMPLEX）。
- **条目 4（Layer 2 形同虚设）**：**已过期** —— 8/20 两笔提交（`85bf9b0` 修默认模型名 + `enabled` 真生效、`60ea73a` 加 openai-compat 后端）已解决。剩余问题是「何时调用」而非「能否调用」，并入任务级路由后成为每任务一次。
- **条目 5（无上下文护栏 / fallback 未接线）**：**已过期** —— `maxTokensForceComplex`（默认 100k）与 `tierConfig.fallback` 均已接线（`server.ts:274` / `server.ts:327`）。遗留一个性能项：护栏每请求 `JSON.stringify(rawBody)`，247KB body 实测 0.717 ms/次。
- **条目 6（注释过时）**：`Force SIMPLE` 与 `15-dim classifier` 两处注释已不在 `server.ts`。但 `src/router/` 2546 行 15 维打分器仍未接线，而 README / ROADMAP / CLAUDE.md / docs 多处仍以「15 维（或 14 维）」描述 live 行为 —— 文档指向死代码，须决定删除或收编。

**新发现的结构性缺陷（登记为 D-002）**：所有档位调整均为单向升档，无任何下调通路。`long` 会话 +1、`requiresTools` +1、低置信兜底 +1 三处叠加，实测「把这个文件的函数改个名」在 `long + requiresTools` 下落 REASONING；真实日志 161/165 条恒为 `long`，故线上每条至少吃一级升档，SIMPLE 只剩 greeting 与 haiku 后台任务能命中。另：`checkRules` 中 reference 早于 complex 且命中即 return，「继续深入分析这个模块的架构设计」被裸词「继续」降到 MEDIUM。

**观测前提**：`~/.nexusrouter/logs/` 现有 165 条**全部缺 `promptCharsSanitized`**，即全部产生于 8/20 修复之前（最新 8/18 05:51）。修复有效性已单独验证，但修复后零观测 —— 拿这批日志标注等于给已不存在的行为建基线。

## 讨论后确认的改进优先级（ROI 排序，2026-08-21 修订）

> 执行状态（同日）：第 0 步 🔲、1 ✅、2 ✅、3 ✅、4 🔲、5 🔲。已完成项对应 ROADMAP 4.1/4.2/4.3，详见 [D-002 处置结果](../../ROADMAP.md)。

第 0 步（零成本，阻塞后续全部）：挂真实流量攒 8/20 修复后的日志。

1. ✅ **手写回归集**（60~100 条中英文用例，覆盖四档 + 上述全部陷阱）接进 `npm test`。不依赖生产数据，能立刻锁住棘轮与 reference 短路。等价于 ROADMAP 4.5「回归门禁」。→ `src/classifier/tier-regression.test.ts`，53 条
2. ✅ **定义档位语义**（四档 vs 三档；difficulty 轴与 thinking 轴是否拆开）。taxonomy 未定则标注无从谈起，故必须排在标注前面。前提：live 四档全是 `claude-opus-*`，「该强给弱」的质量代价很小，真实代价是 thinking token 全局多付 —— 代价矩阵需按此重算。→ [`tier-taxonomy.md`](tier-taxonomy.md)，结论保留四档（能力轴 × 思考轴的乘积）
3. ✅ **修决策结构**（按 bug 修，不是调参）：Layer 3 升档改为有条件 / 有封顶；Layer 1 置信度门改为可达或删除；reference 降级为弱信号；收紧 `derive` / `logical` / `security` / `architecture` 等裸词。→ 另附启发式基线由 SIMPLE 翻转为 MEDIUM（棘轮的真正成因）、CJK 词数折算
4. 🔲 **任务级路由**（原条目 1 遗留项，见下方修订）。
5. 🔲 **Layer 2 只接边界流量**：到这一步已是每任务一次调用，延迟预算充足。

初版排序中的「离线评估攒标注」下移至第 2 步之后（依赖 taxonomy 与新日志）；「embedding 替换 Layer 1」从路线图移除，理由见下。

### 修订：任务级 tier 记忆不再缓议

条目 1 的遗留项曾以「会引入状态，与无状态分类器设计冲突」缓议。该反驳不成立：

- 路由器**已经有状态** —— `server.ts` 的 `retryIndexByText` / `retryIndexByAgent` 就是模块级 Map + 窗口逐出。
- agentic loop 中 `extractClassificationText` 每轮回溯到的是**同一段文本**（日志实证：164 条共享同一 `promptPreview`，`messageCount` 从 209 单调爬到 229）。按任务缓存不是新增状态，而是把重复上百次的确定性计算记住一次。

它同时解掉续轮降档，并把 LLM 分类成本从每请求摊成每任务 —— 是让 Layer 2 真正可用的前提，故升为第 4 优先级。

### 修订：embedding 分类器不列入路线图

原整体方案将 embedding 分类器定为「主力，替换 Layer 1 数词数」。该方向不成立：embedding 相似度测的是 **topic** 而非 **difficulty**（「重构这个函数」与「重构整个架构」在向量空间里很近）。要从向量读出难度，要么训一个 head（需要标注数据，正是缺的那样东西），要么就是 LLM 判官 —— **embedding 在标注问题的下游，不是它的替代**。

改为：规则 → LLM 判官（`openai-compat.ts` 已实现）。仅当 LLM 层延迟确实不可接受、且已有标注集时，再回来考虑 embedding。

## 整体方案讨论（2026-08-19，条目 2~6 之上的元讨论）

> 历史原文，保留作决策轨迹。其中 embedding 主力方向与 ①~④ 落地顺序已于 2026-08-21 修订，现行版本见上方「改进优先级（2026-08-21 修订）」。

问题：字数/轮次/token 量/关键词等表面特征无法理解语义，分类准确率是项目核心，如何系统性提升？

结论：

- **第一敌人是"准确率无定义"，不是"没有语义"**：无标注数据、无评估集、阈值靠拍。且错误代价非对称（该强给弱 = 质量可见崩；该弱给强 = 静默多花钱），路由器应让错误偏向后悔小的方向（拿不准升档），而非追求"最准"。四分类对 CC 场景过难，本质是 cheap/strong/reasoning 三档决策。
- **架构方向：规则降级、语义层上位**。规则只保留高精度短路（问候/感谢/后台 hint——读的是事实不是文本）；主力换成 embedding 分类器（本地小模型如 bge-m3，毫秒级，天然跨语言，顺带解决条目 3 的中文问题）；margin 小的边界流量（<5%）走本地小 LLM（qwen3:4b）。参考：LMSYS RouteLLM（训练小路由器验证可行）、FrugalGPT 级联。
- **落地顺序**：① 路由日志加 outcome 信号（重试/升档/采纳）+ 标注 200-500 条真实 CC 流量拿基线 → ② 决策策略修正（ambiguous 升档、四档并三档）→ ③ embedding 分类器替换 Layer 1 数词数 → ④ 修 Layer 2 Ollama 只接边界流量。
- 2026-08-19 补充：日志导出工具不做（用户可自行取 `routing-*.jsonl`）。标注格式 = 日志字段 + `expectedTier` + 可选 `note`；采样按 `layer` × `finalTier` 分层 + 全量 fallback 样本，200~300 条出基线。

## 发散讨论：本地/私有部署模型做分类（2026-08-19）

> 历史原文，保留作决策轨迹。其中「embedding 分类（毫秒级）」一档已于 2026-08-21 从级联中移除，其余（LLM 判官的可行性、延迟预算、工程必选项）仍成立。

**Q1：本地小模型能否理解语义、判断难度？**

- 分类/难度判断比生成容易几个数量级（BERT 级 0.1B 模型意图分类即可 90%+，RouteLLM 验证）。2B~4B（qwen3:4b）对四档判断够用；35B-A3B 级私有 MoE 属性能过剩，但过剩的用法：输出结构化判断（难度 + 任务类型 + 置信度 + 理由），顺带解掉 tier 轴混淆；私有部署 prompt 不出内网。
- 私有部署真正价值 = **边际成本为零**，"舍不舍得调"的成本约束消失，权衡结构变为纯延迟预算。
- 冷水：模型再强也有系统性偏差（啰嗦偏差：长 prompt 判更难；领域偏差）。标注评估集仍是前提——评估集证明分类器准，不是分类器自我证明。

**Q2：对响应速度的影响**

- 分类串行在转发之前，延迟 1:1 加到 TTFT。A3B 级 MoE 常驻部署单次约 100~~300ms（几百 token prefill + 约束输出），占上游 TTFT（0.5~~3s）的 10~30%。
- 级联把开销压到近零：高精度规则短路（~~0ms，吃 30-50%）→ embedding 分类（毫秒级）→ 仅 5~~10% 边界流量走 35B 分类。
- 工程必选：输出约束（十几 token）、模型常驻（keep_alive，35B 冷启动分钟级）、超时兜底（500ms~1s 回落启发式，即现有 Layer 3 设计）、确认并发排队行为（CC 主会话+后台任务突发）。

---

## 2026-09-01：新日志分析（1114 条）与「skill 是否参与难度判断」讨论

### 一、新日志分析结论（8/28~9/1，routing 1114 条 / outcome 48 条 / usage 1114 条）

新字段（`classificationPreview` / `heuristicScore` / `classificationStale` / `classificationAgeTurns`）全部落地，4.4 标注的硬前置达成。

- 🔴 **新缺陷（D-009，D-001 同构）：skill 正文污染分类输入。** 67 条（6%）把 host 注入的 SKILL.md 正文当用户意图分类：`proves` → REASONING ×33（`systematic-debugging` 正文）、`trade-offs` → COMPLEX ×34（`brainstorming` 正文）。根因：`sanitizeForClassification` 只剥 `<system-reminder>` 包裹块，而 skill 注入是无包裹的普通 user 消息（`Base directory for this skill:` 开头）。更恶劣的是二次效应：skill 注入成为「最近一条含文本的 user 消息」后，该任务后续每一轮 tool_result 回调都回溯到它，同一文本被重复定档最多 34 次、`ageTurns` 最高 136 —— 一次 skill 调用污染整个任务剩余轮次。
- **Layer 1 死代码第二次实证**：`layer: "heuristic"` 0/1114，`heuristicScore` 上限 0.90 < 阈值 0.92，86% 流量走兜底。且即使下调阈值也只改标签不改档位 → 结论不是调参，是**删掉置信度门、承认两层架构**（随 4.6 与基线同批落地，避免提前动结构影响口径）。
- **D-005 量化坐实**：81.5%（908/1114）请求分类的是陈旧文本，`ageTurns ≥ 10` 有 404 条；236 个唯一输入对应 1114 次分类，**78.8% 是重复计算** → 任务级 tier 记忆从「待议」升级为「该做」，它是 Layer 2 可用的前提。
- **护栏退化**：`contextForcedComplex` 命中 32.7%（364 条；原判 MEDIUM 315 / **SIMPLE 49**）。`estimatedTokens` 中位数 82.6k，CC 长会话常态下护栏从「兜底」退化为「常开升档」，恒真信号不含分类信息（同 D-001 的 `hasTools`）。方向：从「升档」改为「按窗口元数据过滤候选模型」——大上下文的平凡查询需要的是大窗口便宜模型，不是更强的模型；49 条 SIMPLE→COMPLEX 两级跳档样本进 4.4 专门审。
- **成本数字无实测证据**：账面节省 $10.73（11.7%），但 `usageSource: estimated` 占 1081/1114，真实上游 usage 仅 5 条；COMPLEX/REASONING 档 saved=$0（映射模型与 baseline 同价）。4.5 出报告时估算与实测必须分开统计。
- 健康项：重试 4.3%（46 same-text / 2 model-switch），D-006 修复后形态正常；`classifyLatencyMs` 中位 0ms、最大 4ms。

### 二、「skill 是否参与难度判断」讨论结论（重要资产）

问题：skill 正文在 Layer 0 是纯噪声（可剥离），但 skill 本身是提示词、能影响任务难度（「读单一文档的 skill」vs「汇总项目信息写对接文档的 skill」），如何正确利用？

达成一致的判断：

1. **skill 是「程序」，不是「文本」。** 请求实际工作量 = 任务（用户指令）× 上下文（项目状态）× 程序（执行步骤）。skill 注入的是第三部分。一旦 skill 被加载，后续实际执行的工作主要由 skill 的程序决定，用户指令退化为程序的参数 —— 活跃 skill 对难度的预测力可能高于用户指令本身。
2. **但 skill 同时是难度压缩器。** 它把「怎么做」外包给提示词：同一个任务，有 skill 时模型按食谱执行（规划负担消失），无 skill 时模型要自己规划。skill 抬高**工作范围（scope）** 的同时降低**所需能力（capability）**，净效应取决于 scope 维度 → 不能笼统「有 skill 就升档」。
3. **Layer 0 必须剥离正文，高层也不该读原文。** skill 的难度信息编码在程序语义里（几步、是否跨文件、有无判断分支），关键词层读不懂；而 skill 内容恒定（一个用户几十份、每份不变），请求时让 LLM 反复读同一份文档是对延迟与 token 的浪费 —— 与 D-005「确定性重复计算应被记住」同理。
4. **正确利用形态 = 静态预计算 + 结构化特征 + 下限规则：**
   - 离线/首次遇见时为每个 skill 生成 profile（`scope`: single-artifact / multi-file / project-wide；`tierFloor`；`summary`），按路径 + 内容 hash 缓存，用户可手改；
   - 请求时只提取 skill **名字**作为结构化信号，不读正文；
   - 组合规则：**floor 不升档**（由具体信号驱动，符合 D-002 规矩）；**封顶 COMPLEX、永不指向 REASONING**（skill 是程序，程序不产生推导链 —— taxonomy 规则 4）；与用户指令分类结果**取 max，不叠加**；
   - Layer 2 启用时喂 skill 名 + profile summary，不喂原文。
5. **边界（保留意见）**：skill 身份是衍生信号（加载哪个 skill 是 host 模型的预读），不能当独立证据加权过重；占比决定投入，先观测后建设。

落地顺序（跟踪项）：

- [x] ① 剥离 skill 正文 + 提取 skill 名（修 D-009）→ 本次提交
- [x] ② 路由日志记 `activeSkill`（观测，量化 skill 流量真实占比 —— 现有日志只能确认下限 6%，中途加载不可见）→ 本次提交
- [ ] ③ 4.4 标注时 skill 相关任务单独分层，验证 skill scope 与人工判定的相关性
- [ ] ④ 相关性成立再上 profile 表 + floor 规则（若常驻 skill 仅两三个，手写几行 JSON 即可，自动生成机制不必做）
