# 分类器改进讨论清单（防止发散遗漏）

> 起源：2026-08-19 关于"当前路由规则是否足够、是否过于粗放"的讨论。
> 范围：live 链路 = `src/server.ts` → `src/classifier/hybrid.ts`（`src/router/` 的 15 维 sigmoid 打分器未接线，不在本清单内）。

## 已识别的粗放点（ backlog ）

1. **分类输入是全部历史 user 消息拼接**（`server.ts:84`）→ 长会话词数虚增顶到 COMPLEX；历史关键词污染当前轮
2. **Layer 1 本质是数词数**（>200 词 COMPLEX / >50 MEDIUM），长度 ≠ 难度
3. **关键词表英文中心**：reasoning/complex 词表纯英文，`\b` 对中文无效（`hybrid.ts:46` 自认）；中文"证明/推导/分析架构"miss
4. **Layer 2 语义层形同虚设**：`ollama.enabled` 默认 false，且默认模型名 `qwen3.5:2b/4b` 在 Ollama 注册表不存在
5. **无上下文长度护栏**：live 链路不看 token 量，大上下文可能路由到小窗口便宜模型；tier `fallback` 列表未接线（`server.ts:135` 只取 primary）
6. **小问题**：`server.ts:324` 注释 "Force SIMPLE" 与融合数学不符（分类器给 REASONING 时后台任务实际落 MEDIUM）；`server.ts:39` 注释 "15-dim classifier" 过时（实际是 HybridClassifier）

## 逐条讨论进度

### 条目 1：全历史 vs 当前轮 —— 讨论完毕，改动进行中 ✅→🔨

讨论结论：

- "复杂任务后回复'继续'被路由到 SIMPLE"的场景不存在：Layer 0 reference 模式（`/继续/`）对当前轮直接命中 → MEDIUM（conf 1.0），与是否取历史无关。实际风险是 MEDIUM vs COMPLEX 的降档，不是 SIMPLE。
- 全历史并没有保护该场景：`checkRules` 中 reference 先于 complex 检查，"继续"命中后直接 return，历史中的复杂关键词不生效。
- **真正的坑**：CC agentic loop 每次工具回调产生 tool_result-only 的 user 消息，`extractText`（`anthropic.ts:46`）丢弃该块 → 文本为空。naive 的"只取当前轮"会让每个工具回调轮落入空文本兜底 → SIMPLE，复杂任务中途全程降档。
- **最终方案**：取"最近一条含真实用户文本的消息"——从最新 user 消息往回跳过剥离后为空的（tool_result-only），用第一条非空的做分类。历史污染与续轮降档同时解决。

后续遗留（单独讨论）：会话级 tier 记忆——continuation 轮继承上一轮非 SIMPLE 档位做下限（可衰减）。会引入状态，与无状态分类器设计有冲突，待议。

### 条目 2~6：待讨论

## 讨论后确认的改进优先级（ROI 排序，初版）

1. 分类输入改为最近一条真实文本消息（条目 1，进行中）
2. 补中文 reasoning/complex 关键词表
3. token 量护栏 + fallback 列表接线
4. 修复或移除 Ollama 层（模型名改真实存在的，如 qwen3:4b）
5. 离线评估：用路由日志攒标注数据，替代手调阈值（0.92/0.75）

## 整体方案讨论（2026-08-19，条目 2~6 之上的元讨论）

问题：字数/轮次/token 量/关键词等表面特征无法理解语义，分类准确率是项目核心，如何系统性提升？

结论：

- **第一敌人是"准确率无定义"，不是"没有语义"**：无标注数据、无评估集、阈值靠拍。且错误代价非对称（该强给弱 = 质量可见崩；该弱给强 = 静默多花钱），路由器应让错误偏向后悔小的方向（拿不准升档），而非追求"最准"。四分类对 CC 场景过难，本质是 cheap/strong/reasoning 三档决策。
- **架构方向：规则降级、语义层上位**。规则只保留高精度短路（问候/感谢/后台 hint——读的是事实不是文本）；主力换成 embedding 分类器（本地小模型如 bge-m3，毫秒级，天然跨语言，顺带解决条目 3 的中文问题）；margin 小的边界流量（<5%）走本地小 LLM（qwen3:4b）。参考：LMSYS RouteLLM（训练小路由器验证可行）、FrugalGPT 级联。
- **落地顺序**：① 路由日志加 outcome 信号（重试/升档/采纳）+ 标注 200-500 条真实 CC 流量拿基线 → ② 决策策略修正（ambiguous 升档、四档并三档）→ ③ embedding 分类器替换 Layer 1 数词数 → ④ 修 Layer 2 Ollama 只接边界流量。
- 2026-08-19 补充：日志导出工具不做（用户可自行取 `routing-*.jsonl`）。标注格式 = 日志字段 + `expectedTier` + 可选 `note`；采样按 `layer` × `finalTier` 分层 + 全量 fallback 样本，200~300 条出基线。
