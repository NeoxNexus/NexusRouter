# Usage-Defense 对齐审计与修复 — 2026-08-26

## 背景

用户要求将 NexusRouter 的 token 计费/用量逻辑与 `new-api-main`（Go 版 LLM 网关）进行对照，确认是否一致，并修复已识别的 gaps。

## 对照结论（高层）

| 维度                  | new-api                                                 | NexusRouter                  | 差异评估                                         |
| :-------------------- | :------------------------------------------------------ | :--------------------------- | :----------------------------------------------- |
| 目标                  | 多租户预付费/扣费网关                                   | 单用户路由 + 可观测性账本    | 正当 scope 差异                                  |
| 预消费                | `EstimateRequestToken` + `ModelPriceHelper`             | 无                           | NexusRouter 无 quota 体系，不需要                |
| 结算                  | `PostTextConsumeQuota` / `calculateTextQuotaSummary`    | `buildUsageEntry` + `costOf` | 等价，NexusRouter 额外有 counterfactual baseline |
| 用 Usage 三道防线     | ① `FORCE_STREAM_OPTION` 注入 ② 多点 SSE 抽取 ③ 本地估算 | 同构，但默认关闭             | **缺陷**：默认关闭导致网关模型上报全 0           |
| 字符级估算            | 按 provider 分词器权重                                  | `length / 4`                 | **缺陷**：中文低估 ~5×，base64 图像高估 ~300×    |
| Anthropic cache 5m/1h | 已拆分                                                  | 硬编码 1h=0                  | **缺陷**：1h cache write 按 5m 计费              |

## 修复内容

### 1. 修复 `recordUsage` fallback-estimation 接线 bug（高优先级）

- **文件**：`src/server.ts` / `src/accounting/usage-entry.ts`
- **根因**：`applyFallbackEstimation` 的结果被赋给局部变量 `capture` 但后续字段仍读取 `input.capture`，导致 MiniMax 等网关模型的全 0 usage 被直接入账。
- **修复**：将用量行构建逻辑抽到纯函数 `buildUsageEntry`，并添加突变测试验证的回归测试。
- **回归测试**：`src/accounting/usage-entry.test.ts`（13 tests）。

### 2. 启用 `noUnusedLocals` / `noUnusedParameters` 结构防御

- **文件**：`tsconfig.json`
- **效果**：13 处历史死代码被暴露，其中包括 `server.ts` 自身的 2 个死引用；`index.ts` 被发现从未实际 re-export `startServer` / `createServer`（头部文档已 advertise）。
- **修复**：删除/下划线化死符号，并补全 `startServer` / `createServer` 的公开导出（additive，零破坏）。

### 3. 默认开启 usage-defense 双开关

- **文件**：`src/config/schema.ts`
- **变更**：
  - `injectStreamUsage`: `false` → `true`
  - `estimateMissingTokens`: `false` → `true`
- **兼容性**：显式配置保持原值；未写该键的旧配置自动获得新默认值（Zod default）。
- **风险说明**：`injectStreamUsage` 会向 OpenAI 流式请求附加 `stream_options.include_usage`，可能让严格校验的上游 400；但 per-provider 开关仍是逃生口，且大多数 SDK 已兼容该字段。

### 4. 移植 new-api 字符级加权估算模型

- **文件**：`src/adapter/token-estimator.ts` / `src/adapter/usage-sniffer.ts`
- **覆盖**：CJK / 拉丁词 / 数字 / 空格 / 换行 / emoji / 数学符号 / URL 分隔符 / `@`，分 OpenAI/Claude/Gemini 三族权重。
- **集成**：`applyFallbackEstimation` 在传入 `model` 时启用新估算器；input 和非流式 output 使用字符级加权，流式路径在启用 `estimateMissingTokens` 时累积 `delta.content` / `delta.text`。

### 5. 估算前剥离 base64 多模态内容

- **文件**：`src/adapter/token-estimator.ts`
- **覆盖**：OpenAI `image_url` data URI、Anthropic `image.source.data` base64。
- **效果**：避免 1MB 图片 base64 被算作 ~35 万 token。

### 6. 拆分 Anthropic 5m/1h cache-write tokens

- **文件**：`src/adapter/usage-sniffer.ts`
- **字段**：读取 `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`。
- **归一化**：当 split 缺失时全部归入 5m（保持旧行为）；当 split 和小于 aggregate 时，差额归入 5m。

### 7. 修复流式 output 估算被 SSE 框架字节放大

- **文件**：`src/adapter/usage-sniffer.ts` / `src/server.ts`
- **根因**：`responseBytes` 是整条 SSE 流的原始字节数，包含 `data:` 框架、`id`、`object`、`choices` 等字段，一个 token 正文往往裹着 150+ 字节，除以 4 会放大 30 倍以上。
- **修复**：`createUsageSniffer` 新增 `accumulateContent` 选项；`server.ts` 在 `estimateMissingTokens` 开启时启用，sniffer 边收流边从 `delta.content` / `delta.text` 提取实际内容文本（上限 4KB），`applyFallbackEstimation` 优先用该文本做字符级估算。
- **性能**：默认关闭累积时不影响 TailWindow 性能回归门；启用时 8000 chunks / ~1.87MB 仍在数毫秒级。

### 8. 大屏总 token 计入 cache write

- **文件**：`src/dashboard/web.ts`
- **根因**：`formatRecent` 的总量只算了 `inputUncached + cacheRead + output`，漏掉 `cacheWrite5m/1h`，导致显示口径与 `costOf` 计费口径不一致。
- **修复**：总量加入两种 cache write，并在 cache 列同时展示 read / write 数量。
- **测试**：`src/dashboard/web.test.ts` 新增 `formatRecent` 单测。

## 质量门禁

| 门禁                | 结果         |
| :------------------ | :----------- |
| `npm run typecheck` | ✅ 0 errors  |
| `npm run build`     | ✅ success   |
| `npm test`          | ✅ 690 / 690 |

## 变更文件清单

- `src/accounting/usage-entry.ts`（新建）
- `src/accounting/usage-entry.test.ts`（新建）
- `src/adapter/token-estimator.ts`（新建）
- `src/adapter/token-estimator.test.ts`（新建）
- `src/adapter/usage-sniffer.ts`
- `src/adapter/usage-sniffer.test.ts`
- `src/config/schema.ts`
- `src/config/config.test.ts`
- `src/config/default-config.ts`
- `src/cli.test.ts`
- `src/dashboard/tailer.ts`
- `src/dashboard/web.ts`
- `src/dashboard/web.test.ts`
- `src/index.ts`
- `src/load-test/runner.ts`
- `src/router/rules.ts`
- `src/server.ts`
- `tsconfig.json`

## 遗留/后续建议

1. **注入 usage chunk 的客户端可见性**：new-api 通过 `ShouldIncludeUsage` 将「是否注入」与「是否转发 chunk」解耦；NexusRouter 当前会原样转发最终 usage chunk。Passthrough 红线下无法低成本重写 SSE，但应在文档中声明该行为。
2. **真实 tiktoken**：OpenAI 模型可接入 `js-tiktoken` 替换估算器，进一步提升 OpenAI 路径精度。
3. **价格注册表补齐**：`cacheWrite5m`/`cacheWrite1h` multipliers 已存在默认值，但具体模型覆盖度依赖 `models.ts`；若新增 Claude 系列模型需同步注册。
