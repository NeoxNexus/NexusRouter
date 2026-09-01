# NexusRouter Phase 优先级与任务拆分方案

> 日期：2026-03-08
> 目的：将当前认知转化为可执行 Phase，供 `ROADMAP.md` 渐进式引入和后续逐 Phase 执行。

## 1. 排期原则

优先级排序依据：

1. 先解决会放大后续成本的问题
2. 先统一“真实运行主线”和“文档主叙事”
3. 再做准确率、性能、可观测性和生产化

## 2. 建议 Phase 顺序

### Phase 3：架构收口与文档对齐

目标：

- 明确唯一 authoritative routing path
- 清理品牌与旧产品残留
- 让 README / docs / plugin metadata 对齐当前系统

核心任务：

- 梳理 `server.ts` 与 `router/` 的职责边界
- 设计统一 `RoutingDecision`
- 收敛配置与路由入口
- 清理 `ClawRouter` / `BlockRun` / `x402` 文档残留

产出：

- 架构方案文档
- 更新后的 README / architecture / configuration / plugin metadata
- 统一决策主线实现

### Phase 4：分类 Benchmark 与正确性验证

目标：

- 为 authoritative router 建 benchmark
- 建立准确率、F1、混淆矩阵
- 对规则、启发式、AI fallback 的边界做调优

核心任务：

- 设计 benchmark 样本格式
- 建 500+ 标注集
- 自动化 runner
- 调优阈值与关键词

产出：

- benchmark 数据集
- benchmark 报告
- 调优后的参数与测试

### Phase 5：增强能力接线

目标：

- 将“已实现但未接入”的能力分批接入主链

核心任务：

- Request dedup
- Response cache
- Session persistence
- Session journal
- Compression
- Usage logging / stats / report

产出：

- 新 middleware / pipeline
- 对应集成测试
- 文档中的功能状态说明

### Phase 6：可观测性

目标：

- 让系统具备可调试、可量化、可追踪能力

核心任务：

- 结构化路由决策日志
- Prometheus metrics
- `/health` / `/metrics` / debug endpoints 完善
- 响应头元数据增强

产出：

- metrics 端点
- dashboard 所需数据基线
- routing decision log schema

### Phase 7：性能与生产强化

目标：

- 把当前系统从“开发可用”推进到“生产可部署”

核心任务：

- 真正 passthrough 优化
- adapter 单例化
- 压测与瓶颈定位
- Docker / compose / Ollama sidecar

产出：

- 性能测试报告
- 部署文档
- 生产化配置模板

### Phase 8：发布与生态接入

目标：

- 完成 npm 发布与外部接入文档闭环

核心任务：

- API 文档完善
- Agent 接入示例完善
- CHANGELOG / semver / tag
- release checklist

产出：

- 发布包
- 最终用户文档
- release note

## 3. 建议交付物矩阵

| Phase   | 主要交付物                                    |
| :------ | :-------------------------------------------- |
| Phase 3 | 架构收口方案、文档统一、主链重构              |
| Phase 4 | benchmark 数据集、runner、准确率报告          |
| Phase 5 | middleware/pipeline 接线、缓存/会话/压缩/统计 |
| Phase 6 | metrics、结构化日志、调试端点                 |
| Phase 7 | 压测报告、Docker、性能优化                    |
| Phase 8 | 发布文档、npm publish、release checklist      |

## 4. 执行注意事项

- 每个 Phase 开始前先确认其前置文档已存在且与当前代码一致
- Phase 内只做一类主目标，避免同时推进“收口 + 大功能新增”
- 所有功能型 Phase 必须以集成测试和文档更新收尾

## 5. 结论

当前最合理的路线不是继续向后堆功能，而是：

**先收口，再验证，再接线，最后生产化与发布。**
