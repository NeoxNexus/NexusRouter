# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 NexusRouter 核心开发准则 (Manifesto)

**注意：在执行任何开发任务前，必须严格遵守以下5点红线原则。** 详细规范请使用工具或文件读取能力主动查阅扩展文件。

1. **双轨驱动 (SDD+TDD)**：必须先明确核心设计与数据流，写功能前**绝对优先编写测试**并覆盖异常边界。（详见 `.claude/rules/workflow.md`）
2. **严守工作流与门禁**：`ROADMAP.md` 是唯一真相源，任务必须同步。提交前必须过 `typecheck`, `build` 与 `test` 100% 绿灯。（详见 `.claude/rules/workflow.md`）
3. **架构与性能底线**：保持极致毫秒级性能，保证**绝对向后兼容**（零感知升级），合理借用策略/插件等设计模式。（详见 `.claude/rules/architecture.md`）
4. **对等辩驳 (Critical!)**：指令非圣旨！若发现人类要求有漏洞或技术债务，务必质疑、列出优缺点并**强力提出更优替代方案**。（详见 `.claude/rules/agent-behavior.md`）
5. **产品级交付**：输出必须具备极客视觉美感，注重前沿系统兼容，使用专业架构图（Mermaid）与精准排版。（详见 `.claude/rules/agent-behavior.md`）

---

## 项目概述

NexusRouter — 智能 LLM 路由器，为每个请求选择最合适的模型。通过三层分类器 (规则 + 启发式 + Ollama) 在 <10ms 内完成路由。支持 41+ 模型 (OpenAI、Anthropic、DeepSeek、Google 等)，使用直接 API 调用。

## 常用命令

```bash
# 构建项目
npm run build

# 开发模式 (watch)
npm run dev

# 运行测试
npm run test              # 单元测试
npm run test:watch        # watch 模式
npm run test:resilience:quick   # 快速弹性测试
npm run test:resilience:full     # 完整弹性测试

# 运行单个测试文件
vitest run src/router/selector.test.ts

# 代码质量
npm run lint              # ESLint
npm run format            # Prettier 格式化
npm run format:check      # 检查格式化
npm run typecheck         # TypeScript 类型检查
```

## 项目架构

### 核心流程

```
请求 → 三层分类器 → Tier → 选定模型 → 上游 API
```

### 关键模块

| 模块        | 位置                  | 职责                                                   |
| ----------- | --------------------- | ------------------------------------------------------ |
| Server      | `src/server.ts`       | Fastify HTTP 服务器，处理 OpenAI 兼容的 /v1/chat/completions |
| Classifier  | `src/classifier/`     | 混合分类器 (规则 + 启发式 + Ollama)                    |
| Router      | `src/router/`         | Tier 选择器 (SIMPLE/MEDIUM/COMPLEX/REASONING)           |
| Config      | `src/config/`         | YAML 配置加载 + Zod 验证                               |
| Ollama      | `src/ollama/`         | 本地 LLM 客户端，用于 AI 分类                           |

### 三层分类器

| 层级 | 延迟   | 描述                                           |
|------|--------|-----------------------------------------------|
| 规则 | <0.1ms | 问候语、感谢语、关键词匹配                      |
| 启发式 | <2ms  | 14 维文本特征评分 (代码模式、对话长度等)        |
| AI (Ollama) | <10ms | 本地 LLM 分类 (可选)                         |

### 路由层级 (Tiers)

- **SIMPLE** — 事实查询、问候、翻译 → gpt-4o-mini
- **MEDIUM** — 总结、解释、数据提取 → gpt-4o
- **COMPLEX** — 代码生成、多步分析 → Claude Sonnet
- **REASONING** — 证明、逻辑、数学 → o3-mini

## 配置

配置文件: `config.yaml`

```yaml
router:
  port: 8402
  classifier: hybrid
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92
    ai:
      fallbackConfidence: 0.75

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: anthropic/claude-sonnet-4-20250514
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []

ollama:
  enabled: false
  baseUrl: http://localhost:11434
  models:
    fast: qwen2.5:3b
    accurate: qwen2.5:14b
  timeout: 30000
```

### 环境变量

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `NEXUSROUTER_PORT` | 8402 | 服务端口 |
| `OPENAI_API_KEY` | - | OpenAI API 密钥 |
| `ANTHROPIC_API_KEY` | - | Anthropic API 密钥 |
| `GOOGLE_API_KEY` | - | Google API 密钥 |

## 开发注意事项

- 使用 Fastify 作为 HTTP 服务器框架
- 使用 Zod 进行配置验证
- 使用 YAML 配置文件 (通过 `yaml` 和 `zod` 包)
- 默认端口: `8402`
- 测试使用 `vitest`
