# NexusRouter 路由档位

NexusRouter 把每个请求分类到四个档位之一，然后按 `config.tiers` 映射到具体模型。

## 四级档位

| Tier          | 典型任务                           | 建议模型档位               |
| :------------ | :--------------------------------- | :------------------------- |
| **SIMPLE**    | 问候、列文件、简单问答、状态确认   | gpt-4o-mini / gemini-flash |
| **MEDIUM**    | 常规代码补全、单文件修改、普通对话 | gpt-4o / claude-haiku      |
| **COMPLEX**   | 多文件重构、架构设计、复杂 debug   | claude-sonnet / gemini-pro |
| **REASONING** | 数学证明、深度推理、多步规划       | o3-mini / claude-opus      |

> 具体模型名以你的上游平台（OpenAI、Anthropic、new-api 等）实际开通的为准。

## 配置示例

```yaml
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: anthropic/claude-sonnet-4-5
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []
```

## 关于 fallback

`fallback` 列表在配置中存在，但**当前主链路暂未使用**。配置了也不会自动切换。

建议把上游故障转移交给 new-api 的渠道能力，或等待后续 Phase 接入统一 pipeline。

## 档位选择逻辑

1. **规则层**：问候语、极短文本、明确推理关键词等直接命中规则
2. **启发式层**：15 维评分，超过 `confidenceThreshold` 则直判
3. **Ollama AI 层**（可选）：本地 LLM 兜底
4. **降级**：Ollama 不可用时按启发式结果或默认 MEDIUM 处理

## Agent 画像的影响

同一个 prompt 从不同 Agent 入口进来，可能得到不同 tier。这是设计使然：

- **Claude Code**：大量请求是后台任务，画像会加权压向 SIMPLE
- **OpenClaw**：100% 信任分类器结果

---

_Last updated: v0.12.5_
