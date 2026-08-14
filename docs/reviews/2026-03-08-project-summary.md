# NexusRouter 项目总结报告

> 日期：2026-03-08
> 目的：沉淀当前项目认知，作为后续 Roadmap 与重构决策的基线文档。

## 1. 项目定义

`NexusRouter` 是一个本地运行的 LLM 路由代理，目标是在不修改上层 Agent 工作方式的前提下，兼容 OpenAI / Anthropic 风格请求协议，对请求做本地复杂度判断，并自动转发到更合适的上游模型。

它的核心价值不是“统一 SDK”，而是“本地智能分流层”：

- 为 Claude Code、OpenClaw、通用 OpenAI 风格客户端提供兼容入口
- 基于本地规则、启发式和可选 Ollama 分类器进行请求分级
- 将不同复杂度任务映射到不同 provider/model，以控制成本和延迟

## 2. 当前系统主链路

当前真实运行的主链路位于 `src/server.ts`，处理流程如下：

1. 接收 HTTP 请求
2. 按协议交给对应 Adapter 转成统一结构 `UnifiedRequest`
3. 结合 AgentProfile 提取 hints 与权重
4. 调用 `HybridClassifier` 得到 tier
5. 从 `config.tiers` 解析出目标模型
6. 根据 provider 配置转发请求
7. 透传流式或非流式响应

主入口文件：

- `src/server.ts`
- `src/index.ts`
- `src/cli.ts`

## 3. 核心模块拆解

### 3.1 服务与入口层

- `src/server.ts`
- `src/cli.ts`
- `src/index.ts`

职责：

- 启动 Fastify 服务
- 注册 `/v1/chat/completions`、`/v1/messages` 及 Agent 前缀路由
- 承载统一处理流水线
- 输出 `x-nexusrouter-*` 响应头

### 3.2 协议适配层

- `src/adapter/types.ts`
- `src/adapter/openai.ts`
- `src/adapter/anthropic.ts`
- `src/adapter/profile.ts`

职责：

- 把不同协议请求归一化为内部统一结构
- 保留原始 body/headers，方便透传上游
- 对不同 Agent 注入轻量 hints

评价：

- 这是当前项目最清晰、最利于扩展的一层
- 设计模式上采用了 Strategy + Plugin Registry，结构合理

### 3.3 分类层

- `src/classifier/hybrid.ts`
- `src/ollama/client.ts`

当前使用的是“三层混合分类器”：

- `rule`
- `heuristic`
- `ai`（本地 Ollama）
- `fallback`

优势：

- 全本地执行
- 具备降级路径
- Ollama 不可用时不会阻断主流程

### 3.4 路由与选模层

- `src/router/index.ts`
- `src/router/rules.ts`
- `src/router/selector.ts`
- `src/router/types.ts`

这套模块实现了更完整的 15 维评分和选模逻辑，包括：

- 15 维加权评分
- agentic task 检测
- structured output 升级
- eco / premium / agentic tiers
- context window / tool calling / vision 过滤
- cost / baseline / savings 估算

但需要明确：

**当前 `src/server.ts` 主链路并没有接入这套 `route()` 路由器。**

也就是说，仓库目前存在两套并行思路：

- 运行主链：`HybridClassifier + config.tiers`
- 库化增强链：`route() + selector + richer routing config`

这是当前项目最重要的架构事实。

### 3.5 配置层

- `config.yaml`
- `src/config/loader.ts`
- `src/config/schema.ts`

职责：

- 读取 YAML
- 展开环境变量
- 进行结构校验

特点：

- 使用成本低
- 对部署友好
- 约束清晰

## 4. 当前成熟能力

已经形成闭环、具备稳定可用性的能力：

- OpenAI / Anthropic 协议兼容转发
- Claude Code / OpenClaw / 通用 OpenAI 风格路由入口
- 基于本地分类的 tier 选择
- 基于 provider 配置的上游转发
- 流式 SSE 转发
- 配置文件加载与校验
- 较完整的单元测试

本地测试结果：

- 15 个测试文件通过
- 340 个测试通过
- 无失败

## 5. 当前未完全落地的能力

仓库中还存在一批实现了模块、但尚未接入主请求链路的能力：

- `src/response-cache.ts`
- `src/session.ts`
- `src/dedup.ts`
- `src/compression/`
- `src/stats.ts`
- `src/report.ts`
- `src/logger.ts`
- `src/journal.ts`

这些模块说明项目方向并不只是一个简单代理，而是在尝试向“具备记忆、缓存、压缩、统计、可观测”的网关演进。

但从当前真实运行路径看，它们大多仍处于“已实现模块”或“预备能力”状态，而不是默认生效能力。

## 6. 主要问题与风险

### 6.1 双主线并存

项目同时存在：

- `HybridClassifier` 主链
- `route()` 增强链

风险：

- 调参与优化容易分散
- 文档容易写到未接入实现
- 新成员难以判断真实 authoritative path

### 6.2 文档与品牌叙事未完全统一

仓库仍保留大量 `ClawRouter` / `BlockRun` / `x402` 残留：

- `docs/architecture.md`
- `docs/features.md`
- `docs/configuration.md`
- `openclaw.plugin.json`
- `openclaw.security.json`

风险：

- 用户误解当前产品定位
- 代码已重构，文档仍描述旧系统
- 发布时损害可信度

### 6.3 配置与实现局部脱节

例如 `ollama.models.fast` / `accurate` 已在配置中暴露，但 `src/ollama/client.ts` 里仍写死模型名。

风险：

- 配置看似可用，实际不生效
- 后续调试成本上升

### 6.4 观测与生产能力尚未闭环

虽然有 stats/report/logger 等模块，但当前服务主流程尚未真正结构化记录：

- request count
- tier distribution
- provider latency
- upstream failure breakdown
- routing cost metadata

## 7. 工程质量评价

优点：

- 模块边界较清晰
- Adapter 分层设计合理
- 配置校验和测试覆盖较好
- 核心功能不依赖远端分类，降级能力清楚

不足：

- 架构主线尚未收口
- 文档与实现存在显著偏差
- 许多增强模块未接线

综合判断：

- 核心网关能力：中上成熟度
- 文档一致性：中
- 产品叙事清晰度：中偏低
- 生产落地完成度：中

## 8. 优先建议

建议后续工作按以下优先级推进：

1. 收口架构主线，明确唯一运行路由体系
2. 清理品牌与文档残留，保证“代码真实能力 = 文档主叙事”
3. 将缓存、会话、去重、压缩、统计等模块分批接入主链
4. 建立 benchmark 与分类准确率评估机制
5. 补齐可观测性和生产化能力

## 9. 结论

`NexusRouter` 已经不是 demo，而是一个具备明确方向和较好骨架的本地 LLM 路由网关。

它当前最大的短板不是代码实现力，而是：

**项目主线、文档叙事、增强模块接入状态三者还没有完全对齐。**

后续应优先围绕“架构收口 + 文档收口 + 能力接线”推进，这样后续每个 Phase 才有稳定基线。
