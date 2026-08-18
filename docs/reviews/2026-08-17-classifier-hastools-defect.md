# 分类器缺陷评审：`hasTools` 恒真使三层分类器退化

- **日期**: 2026-08-17
- **发现场景**: 接入 Claude Code (CC) + CC-Switch + new-api (gorouter.app) 时实测
- **严重级别**: 高（核心逻辑 —— 直接使项目主要卖点失效）
- **涉及代码**: `src/classifier/hybrid.ts:126-128`、`src/adapter/profile.ts:84-95`、`src/router/selector.ts:130`

---

## 一、结论摘要

`HybridClassifier.checkRules()` 中存在一条无条件规则：请求带 `tools` 即判定为 `COMPLEX`。

而 **Claude Code 的每一个请求都携带完整工具表**，因此对 CC 流量而言 `hasTools` 恒为 `true`。一个恒真的条件不是分类特征，是常量。后果：

1. 14 维启发式层与 Ollama AI 层对 CC 流量**完全不执行**（Layer 0 命中即 return）
2. `SIMPLE` / `MEDIUM` 两档**永不生效**，CC 流量 100% 落在 `COMPLEX` 或 `REASONING`
3. README 承诺的"后台小请求分流到 1/100 成本模型"在主力场景下三重失效

---

## 二、实测证据

### 2.1 真实 CC 形态请求的 tier 分布

本地 mock 上游 + 真实 CC 请求形态（带完整 tools 表 + system prompt）：

| 请求内容 | hasTools | 实测 tier | 上游收到模型 |
|:---|:---|:---|:---|
| `hi` | false | SIMPLE | gpt-4o-mini |
| `hi` | **true**（CC 真实形态） | **COMPLEX** | claude-sonnet-4-6 |
| `list the files in src/` | true | **COMPLEX** | claude-sonnet-4-6 |
| `rename foo to bar in utils.ts` | true | **COMPLEX** | claude-sonnet-4-6 |
| `ok` | true | **COMPLEX** | claude-sonnet-4-6 |
| 架构重构（真复杂任务） | true | COMPLEX | claude-sonnet-4-6 |
| `prove this theorem` | true | REASONING | o3-mini |

除命中推理关键词者，**全部钉在 COMPLEX**。琐碎请求与真复杂请求得到完全相同的档位，分类器没有产生任何区分度。

### 2.2 非单调性：更含糊的请求拿到更便宜的模型

规则顺序问题 —— 引用词检测 (`hybrid.ts:121`) 位于 hasTools 分支 (`hybrid.ts:126`) 之前：

| prompt | hasTools | tier |
|:---|:---|:---|
| `ok` | true | **COMPLEX** |
| `继续` | true | **MEDIUM** |
| `继续修改上面的文件` | true | MEDIUM |
| `ok` | false | SIMPLE |

`ok` 拿到了比 `继续` **更贵**的档位。而 `继续` 是明确需要上文的指代型请求，语义上更难却降了一档。这是把"能力约束"表达成"复杂度 tier"之后，两条规则在同一维度互相踩踏的直接产物 —— 属建模问题，非配置问题。

### 2.3 `thinking` 字段进一步放大问题

`CLAUDE_CODE_EFFORT_LEVEL: max` 会让 CC 请求携带 `thinking` 字段，`claudeCodeProfile.computeWeights` (`profile.ts:90`) 据此把 tier 顶到至少 REASONING。同一个"列出 src/ 下的文件"：

| 请求 | tier | 上游收到 |
|:---|:---|:---|
| 带 thinking | REASONING | o3-mini |
| 不带 thinking | COMPLEX | claude-sonnet-4-6 |

**列目录被路由到了推理模型**。既不省钱，且 o3-mini 本身不擅长工具调用类任务。

### 2.4 成本量级

`src/models.ts` 实际定价：

| 模型 | 输入 /1M | 输出 /1M |
|:---|---:|---:|
| gpt-4o-mini (SIMPLE) | $0.15 | $0.60 |
| claude-sonnet-4.6 (COMPLEX) | $3.00 | $15.00 |

**输入 20 倍、输出 25 倍**，乘在 CC 挂机时的绝大部分流量上。

---

## 三、根因分析

### 3.1 概念混淆：能力约束 ≠ 复杂度判断

- "请求带 tools" → 模型必须支持 function calling，属**能力过滤**
- "任务有多难" → 属**复杂度分级**，才是 tier 该管的事

两者正交。且前提本身错误：`models.ts:302` 中 `gpt-4o-mini` 的 `toolCalling: true`，SIMPLE 档模型完全能处理工具调用。

### 3.2 正确机制已存在但未接线

`src/router/selector.ts:130` 的 `filterByToolCalling()` 正是为此设计 —— 按 `toolCalling` 元数据过滤候选模型，保留 tier 判断不变。

但 `server.ts` 从未 import `router/selector`，**整个 `src/router/` 在主链路上是死代码**。正确的工具躺在仓库里没接线，错误的近似写进了热路径。此项与 ROADMAP Phase 3.3「消除双主线」直接相关。

### 3.3 连带死代码

`heuristicClassify` 内的 hasTools 加权（`hybrid.ts:217-221`，注释自称"双重保险"）**不可达**。因为 `hasTools=true` 时 `checkRules` 必然命中（推理关键词 / 引用词 / hasTools 分支三者之一），Layer 1 永远轮不到。

---

## 四、测试给出了假信心

`src/classifier/hybrid.test.ts:372` —— `"should upgrade tier when hasTools in Layer 1 fallback"`：

该用例 mock 掉 fetch 使 Ollama 失败，断言 `tier === "COMPLEX"`。但 Layer 0 早已返回 COMPLEX，**Ollama 从未被调用，Layer 1 代码路径根本没被触达**。用例未断言 `layer` 字段，错位被完全掩盖。

30 个测试全绿，但 Layer 1 的 hasTools 行为从来没有被验证过。

更严重的是 `hybrid.test.ts:358` —— `"should force COMPLEX when hasTools=true in Layer 0"` **把缺陷行为直接写进了验收标准**。修复实现必然使其变红，需先重写该用例表达期望行为。

---

## 五、修复方向（待验证后执行）

`hasTools` 应拆成两条独立通路：

| 维度 | 归属 | 做法 |
|:---|:---|:---|
| 能力 | `filterByToolCalling` | 把 `router/selector` 接进 `server.ts` 主链路 |
| 复杂度 | `heuristicClassify` | `hasTools` 降为置信度加权信号，删除 Layer 0 硬跳转 |

配套改动：

- `thinking` 的 hintWeight 下调，或改为"至少 COMPLEX"而非"至少 REASONING"
- ~~`model === "auto"` 加大小写归一化~~ → **已修复**（`server.ts:64`，`"Auto"` 曾直接 400）
- 裸模型名（如 `claude-sonnet-4-6`）从 400 改为走自动路由 —— CC 永远不发 `provider/model` 格式

**当前状态：暂不修复。** 先接入真实流量运行一段时间，通过 `~/.nexusrouter/logs/routing-*.jsonl` 收集实证数据，用真实 tier 分布验证上述分析，再按 TDD 修复。

---

## 六、验证方法

已在 `src/logger.ts` 增加 `logRoutingDecision`，主链路每请求落一条结构化日志。关键字段：

| 字段 | 用途 |
|:---|:---|
| `hasTools` | 确认是否恒为 true |
| `hasThinking` | 确认 thinking 字段出现频率 |
| `classifierTier` / `finalTier` | 对比 hint 融合前后差异，量化 profile 影响 |
| `reason` | 命中哪条规则（`has-tools` / `reasoning-keyword` / `reference-pattern` / …）|
| `layer` | 验证 heuristic / ai 层是否真的从未执行 |
| `promptPreview` | 人工判断该请求"本应"是什么档位 |

预期观测结果（若分析成立）：

- `reason: "has-tools"` 占比接近 100%
- `layer: "rule"` 占比接近 100%，`heuristic` / `ai` 近乎为 0
- `finalTier` 仅出现 COMPLEX / REASONING

### 6.1 观测环境

| 项 | 值 |
|:---|:---|
| 上游 | `https://gorouter.app`（new-api），`passthroughApiKey: true` |
| 档位映射 | SIMPLE → `claude-opus-4-8`、MEDIUM → `claude-opus-4-8-thinking`、COMPLEX → `claude-opus-5`、REASONING → `claude-opus-5-thinking` |
| 接入方式 | CC-Switch 供应商 → `http://127.0.0.1:8402/anthropic`，模型设为 `Auto` |
| 日志位置 | `~/.nexusrouter/logs/routing-YYYY-MM-DD.jsonl` |

### 6.2 分析命令

```bash
# 1. reason 分布（验证是否 has-tools 一家独大）
jq -r .reason ~/.nexusrouter/logs/routing-*.jsonl | sort | uniq -c | sort -rn

# 2. layer 分布（验证 heuristic / ai 层是否从未执行）
jq -r .layer ~/.nexusrouter/logs/routing-*.jsonl | sort | uniq -c | sort -rn

# 3. 最终档位分布（验证 SIMPLE / MEDIUM 是否为 0）
jq -r .finalTier ~/.nexusrouter/logs/routing-*.jsonl | sort | uniq -c | sort -rn

# 4. hint 融合造成的档位漂移（classifierTier ≠ finalTier 的请求）
jq -r 'select(.classifierTier != .finalTier)
       | "\(.classifierTier) → \(.finalTier)  thinking=\(.hasThinking)  \(.promptPreview[:50])"' \
   ~/.nexusrouter/logs/routing-*.jsonl

# 5. 人工判断：被送进最高档的到底是什么请求
jq -r 'select(.finalTier == "REASONING")
       | "\(.reason)  tools=\(.toolCount)  \(.promptPreview[:60])"' \
   ~/.nexusrouter/logs/routing-*.jsonl | head -40

# 6. hasTools 是否真的恒为 true
jq -r .hasTools ~/.nexusrouter/logs/routing-*.jsonl | sort | uniq -c
```
