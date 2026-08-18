# Code Review — D-001 修复（2026-08-18）

- **Review target**: commit `03a9d5a` — `fix(d001): 分类器词边界 + tool-intent 移植 + CC 注入剥离 + thinking 开关`
- **Review method**: `/code-review` skill（medium → maximum effort）
- **Agents run**: 9 个角度，其中 2 个成功返回、7 个因网关 502 / 余额 402 失败；已返回的角度覆盖了代码正确性与简化性。
- **Review result**: 5 个真实缺陷，已全部修复；7 个清理/建议项，部分采纳。
- **Fix commit**: `review(d001): ...`（紧随本报告提交）
- **Final gates**: typecheck 0 errors / build 成功 / **419 tests 全绿**

---

## 一、确认并已修复的真实缺陷

### 1. `thinkingMode` 的 “at least” 下限被加权融合稀释

**位置**: `src/server.ts:304`

**问题**: 原实现把 `hintRank` 先 floor 到 2/3，再用 `0.5/0.5` 权重与 classifierRank 平均后 `Math.round`。
- SIMPLE + thinking complex → `Math.round(2×0.5 + 0×0.5) = 1` → **MEDIUM**（文档承诺至少 COMPLEX）
- SIMPLE + thinking reasoning → `Math.round(3×0.5 + 0×0.5) = 2` → **COMPLEX**（文档承诺至少 REASONING）

**修复**: 融合后再 `Math.max(fusedRank, floor)`，保证文档语义。`server.test.ts` 中对应断言从 `COMPLEX/MEDIUM` 改为 `REASONING/COMPLEX`。

### 2. 推理关键词丢失屈折形式

**位置**: `src/classifier/hybrid.ts:48`

**问题**: 改用 `\b` 整词匹配后，`proved/proves/proving/proofs/theorems/derives/derived/mathematically` 以及旧词 `logical` 全部漏判。

**修复**: 扩展 `REASONING_KEYWORDS` 列表，并保留 `logical`（避免 “is this logical?” 漏判）。新增/更新 15 个测试覆盖这些屈折与边界。

### 3. `tool-intent.ts` 正则无法跨行

**位置**: `src/router/tool-intent.ts:34-41`

**问题**: 4 个检测正则使用 `.{0,60}` / `.{0,80}` 但未加 `s` 标志，`.` 不匹配 `\n`；多行 prompt 中动作与目标被换行分隔时检测失败，例如 “please update\nmy order”。

**修复**: 四个正则全部加 `s` 标志；新增 2 个跨行测试。

### 4. 空字符串被送入 Ollama 分类器

**位置**: `src/server.ts:94`

**问题**: 若用户回合只有被剥离的 `<system-reminder>` 块，`classificationText` 为空字符串，`classify('')` 会被送进 Ollama；在 `ollama.enabled=false` 时造成一次无意义的 localhost fetch，在 `ollama.enabled=true` 时本地模型可能基于空 prompt 返回高置信度的任意 tier，复现 D-001 的乱档。

**修复**: `classificationText.length === 0` 时短路，直接返回 SIMPLE fallback，同时仍记录 `promptCharsSanitized: 0`。新增集成测试固化。

### 5. `inferToolRequirement` 签名含未使用的 `_systemPrompt`

**位置**: `src/router/tool-intent.ts:14`, `src/server.ts:92`

**问题**: 函数声明接受 `_systemPrompt` 但完全忽略；`server.ts` 仍传 `unified.system`，给维护者造成“系统 prompt 参与判断”的误导。

**修复**: 移除该参数（保留 toolChoice 作为第二参数），更新所有调用与测试。

---

## 二、清理/建议项及处置

| # | 发现 | 处置 | 原因 |
|:--|:--|:--|:--|
| 1 | `server.test.ts` 多个集成测试重复 boilerplate | **未处理** | 当前 describe 已有 `readLogEntries` / `mockUpstream`；抽取 helper 会提高耦合，且非缺陷。 |
| 2 | `hybrid.ts` 中 `REASONING_PATTERN`/`COMPLEX_PATTERN`/`HEURISTIC_REASONING_PATTERN` 三处重复 `\b(...join('|'))\b` 模板 | **未处理** | 三处目标不同（Layer 0 精确、Layer 1 更宽、复杂关键词），抽成 helper 会牺牲可读性；且关键词均为纯字母，当前无 metachar 风险。 |
| 3 | `server.ts` 中 `!!unified.hasTools` 与 `unified.hasTools` 混用 | **未处理** | `UnifiedRequest.hasTools` 已声明为 `boolean`，但 `!!` 是防御性习惯；统一风格属于 formatting，非 bug。 |
| 4 | `resolveWeightedTier` 中 floor 使用字面量 2/3 | **已部分修复** | 修复 #1 时保留了 `floor` 变量；未抽取到 `TIER_RANK` 是因为 `TIER_RANK` 已经存在，两处使用语义不同（hint vs floor），抽取反而混淆。 |
| 5 | `server.ts` 重复 `unified.rawBody as Record<string, unknown>` 模式 | **未处理** | `UnifiedRequest.rawBody` 当前类型为 `unknown`，cast 是过渡形态；Phase 3 给 `rawBody` 加类型联合时统一改。 |
| 6 | `hybrid.ts` `COMPLEX_KEYWORDS` 用 list+join 而非字面量 | **未处理** | 与 #2 同理，当前关键词无 metachar；literal 不会显著更短。 |
| 7 | `requiresTools` 升级只在启发式层，不覆盖规则层命中 | **未处理（设计如此）** | 规则层已编码复杂度（greeting/thanks/reasoning/reference/complex keyword），能力约束应归 `filterByToolCalling`；当前部署四档均支持工具，无实际风险。 |

---

## 三、重跑验证

```bash
npm run typecheck   # 0 errors
npm run build       # success
npm test            # 17 files, 419 tests passed
```

---

## 四、结论

本次评审共发现并修复 5 个真实缺陷，其中 #1、#3、#4 属于 D-001 修复本身的行为完整性缺口；#2 是词边界改造引入的回归；#5 是上游移植代码的签名误导。

剩余清理项均为非缺陷的风格/架构选择，未纳入本次修复提交，避免制造与 D-001 无关的 diff 噪音。Phase 3 主链收口时建议统一处理 `rawBody` 类型、`requiresTools` 与规则层的交互、以及测试 helper 抽取。
