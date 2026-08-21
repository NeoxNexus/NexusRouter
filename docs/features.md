# NexusRouter 高级特性

NexusRouter 包含多个能力模块，部分已接入主请求链路，部分已实现但尚未接线。本文档区分两者，避免误解。

## 目录

- [已接入主链的能力](#已接入主链的能力)
- [已实现但未接线的能力](#已实现但未接线的能力)
- [计划中的能力](#计划中的能力)

---

## 已接入主链的能力

### 15 维本地复杂度分类

核心能力。对每个请求在本地进行 15 维评分，<1ms 内判定 Tier：

- 规则层（<0.1ms）
- 启发式层（~1ms）
- Ollama AI 层（可选，5-8ms）

### 双协议支持

同时暴露 OpenAI 与 Anthropic 兼容端点：

- `/v1/chat/completions`
- `/anthropic/v1/messages`
- `/openclaw/v1`（旧版兼容）

### Agent Profile 插件

按不同 Agent 动态调整分类权重：

- `claude-code`
- `openclaw`
- `cursor`（框架占位）

### API Key 透传（passthroughApiKey）

支持把客户端自带的 key 原样转发给上游网关，常用于 new-api 远程部署。

### 路由判定响应头

每次响应附带：

| 响应头                     | 含义                                  |
| :------------------------- | :------------------------------------ |
| `x-nexusrouter-tier`       | SIMPLE / MEDIUM / COMPLEX / REASONING |
| `x-nexusrouter-layer`      | rule / heuristic / ai / fallback      |
| `x-nexusrouter-confidence` | 置信度 0~1                            |
| `x-nexusrouter-agent`      | 识别出的 Agent 画像                   |

---

## 已实现但未接线的能力

以下模块在代码库中存在且有单元测试，但**不在当前主请求链路上生效**。

| 模块                     | 文件                                | 状态                                        |
| :----------------------- | :---------------------------------- | :------------------------------------------ |
| Response Cache           | `src/response-cache.ts`             | 未接线                                      |
| Request Deduplicator     | `src/dedup.ts`                      | 未接线                                      |
| Session Store / Journal  | `src/session.ts` / `src/journal.ts` | 未接线                                      |
| Compression              | `src/compression/`                  | 未接线                                      |
| Stats / Report           | `src/stats.ts` / `src/report.ts`    | 未接线                                      |
| 完整 15 维成本感知选模器 | `src/router/selector.ts`            | 未接入主链，当前生效的是 `HybridClassifier` |

这些模块将在后续 Phase 通过统一的 middleware/pipeline 方式接入主链。当前文档中不应把它们描述为"已启用"。

---

## 计划中的能力

- 结构化路由决策日志
- Prometheus `/metrics` 端点
- 真正的 Buffer Passthrough（同协议跳过解析）
- Adapter 单例化与对象复用
- 负载测试与性能基线

详见 [`ROADMAP.md`](../ROADMAP.md)。
