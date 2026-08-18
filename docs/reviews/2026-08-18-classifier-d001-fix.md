# D-001 修复记录：分类侧四项整改（2026-08-18）

- **日期**: 2026-08-18
- **关联评审**: [2026-08-17-classifier-hastools-defect.md](2026-08-17-classifier-hastools-defect.md)
- **验证门禁**: typecheck 0 errors / build 成功 / 408 tests 全绿（基线 365 → +43）

---

## 一、实测修正了评审报告的核心预测

评审报告预测：CC 流量 `reason: "has-tools"` 占比接近 100%，钉在 COMPLEX。

实测 7 条真实 CC 流量（本机 `~/.nexusrouter/logs/routing-2026-08-17.jsonl`）：

| 观测项        | 实测                        | 报告预测               |
| :------------ | :-------------------------- | :--------------------- |
| `reason`      | `reasoning-keyword` **7/7** | `has-tools` ≈100%      |
| `layer`       | `rule` 7/7                  | `rule` ≈100% ✅        |
| `finalTier`   | `REASONING` **7/7**         | COMPLEX/REASONING 混合 |
| `hasTools`    | true 7/7                    | true ✅                |
| `hasThinking` | true 7/7                    | —                      |

**真实根因**：`hybrid.ts` 用 `includes()` 做推理关键词匹配。CC 每轮注入的 skills 清单必含
`improve`（内含 `prove`），在 `has-tools` 分支（原 hybrid.ts:148）**之前**就命中
`reasoning-keyword` → REASONING。`has-tools` 规则实为死代码，被另一个更早触发的 bug 抢在前。

另外 `hasThinking` 也恒真：`~/.claude/settings.json` 设了 `CLAUDE_CODE_EFFORT_LEVEL=max`，
CC 因此每轮带 `thinking` 字段。

## 二、本轮修复项

### ① 推理关键词整词匹配（`src/classifier/hybrid.ts`）

- `includes()` → `\b` 边界正则；`logical` → `logically`（对齐上游 router-core，`logical` 会命中 `logical operator`）
- Layer 1 保留更宽的启发式词表（`calculate`/`solve equation`），启发式只加权不直接定档，误判代价低
- 复杂关键词（`analyze` 等）同样改为整词

### ② 移植上游 `tool-intent.ts`（`src/router/tool-intent.ts`）

从 `@blockrun/router-core`（MIT）移植 `inferToolRequirement`：拆开「宿主每轮挂工具表」（`hasTools`）与
「这一轮真的要动手」（`requiresTools`）。`tool_choice` 协议信号为权威，否则用 action+target 对启发式。
上游曾以 `4ffdc80` 强制 hasTools→agentic、十天后 `d15ebd2` 自撤销，现形态为 tier 与模型表解耦。

`hybrid.ts` 的 Layer 0 `hasTools → COMPLEX` 硬跳转已删除；启发式加权信号从 `hasTools` 换成 `requiresTools`。

### ③ `AgentProfile.sanitizeForClassification`（`src/adapter/profile.ts`）

- `AgentProfile` 新增可选钩子；`claudeCodeProfile` 实现剥离 `<system-reminder>…</system-reminder>` 块（只剥完整闭合块，未闭合则不动）
- 放 profile 层而非分类器：不把 CC 的注入形态固化成全局行为（上游 issue #50 的教训反向——上游只修了「system prompt 污染」，CC 的注入在 user turn，上游修法对它无效）
- **关键不变量（集成测试固化）**：只改喂给分类器的文本；转发上游的 body 逐字节原样

### ④ `hints.thinking` 开关（`config.yaml` 顶层 + schema）

```yaml
hints:
  thinking: off # off | complex | reasoning
```

- `off`（默认）：thinking 不参与档位融合 —— 恒真信号携带零信息量
- `complex` / `reasoning`：thinking 请求至少 COMPLEX / REASONING（后者为旧行为）
- `isBackgroundTask`（haiku）保留全部权重：CC 只在真跑后台任务时请求 haiku

## 三、遗留（并入 Phase 3.3）

1. **能力侧** `filterByToolCalling` 接入需 `router/` 上主链。本轮未做：任意用户配置下「带 tools 的请求必路由到支持 function calling 的模型」暂缺保证。当前部署无实际风险（四档全 `claude-opus-*`）。
2. **阻塞项**：`config.yaml` 四档模型（`claude-opus-4-8` 等）均未注册进 `models.ts`（`supportsToolCalling` 查不到 → 全被过滤 → 触发「全部保留」兜底，等于没接）。必须先解决 `config.yaml` 档位与 `router/config.ts` 硬编码 `DEFAULT_ROUTING_CONFIG` 的双配置源归属。
3. `inferToolRequirement` 动词表不含 `list`（上游原样），「list the files in src/」判 false —— 有意保留，留 Phase 4 benchmark 调优。
