# Code Review Report — Phase 2 (commit: 90a150b)

**审查时间**: 2026-03-05  
**审查范围**: `src/adapter/` (7 files) + `src/server.ts`  
**评分**: ⭐⭐⭐½ / 5  —— 架构清晰、设计合理，存在若干工程质量问题需修复

---

## 🟢 优点

### 1. 架构设计 — 清晰合理
- **策略模式** (`ProtocolAdapter`) 边界清晰，新增协议只需实现接口
- **插件模式** (`AgentProfile`) 不侵入核心，`openClawProfile` 零改造即可使用
- **动态加权** (`resolveWeightedTier`) 优雅地融合 hint 和 classifier，参数化权重
- **职责单一**：`detectProtocol`/`extractAgentFromPath` 各司其职，O(1) 时间

### 2. 向后兼容 — 无破坏性变更
- 原 `/v1/chat/completions` 和 `/v1/messages` 路由保留
- 现有测试 315 个全部通过

### 3. 类型安全
- 所有核心接口有完整 TypeScript 类型，`tsc --noEmit` 零错误

---

## 🟡 需要改进（中等优先级）

### 问题 1：Stream 响应头设置重复 [`server.ts:175-183`]

```typescript
// ❌ 问题：reply.header() 和 reply.raw.writeHead() 重复设置同样的头，
//         Fastify 会忽略 reply.header，因为 writeHead 已经发送了 headers
reply.header("Content-Type", "text/event-stream");
reply.header("Cache-Control", "no-cache");
reply.header("Connection", "keep-alive");

reply.raw.writeHead(result.status, {  // ← 这里才是真正生效的
  "Content-Type": "text/event-stream",  
  ...
});

// ✅ 修复：删除 reply.header() 的那 3 行，只保留 writeHead
```

---

### 问题 2：Stream 错误未被捕获 [`server.ts:186-194`]

```typescript
// ❌ 问题：reader.read() 如果中途上游断开，会抛出异常，
//         但 finally 里 reply.raw.end() 不一定能正确关闭连接
const reader = result.body.getReader();
try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    reply.raw.write(value);
  }
} finally {
  reply.raw.end();
}

// ✅ 修复方案：添加 catch 块，记录错误并销毁 reader
} catch (streamError) {
  req.log.error({ err: streamError }, "Stream read error");
} finally {
  reader.releaseLock();
  reply.raw.end();
}
```

---

### 问题 3：`resolveWeightedTier` 使用内联 import 类型 [`server.ts:210-211`]

```typescript
// ❌ 问题：函数签名里有 inline import，代码可读性差，不规范
function resolveWeightedTier(
  classifierResult: { tier: string; confidence: number },
  hints: import("./adapter/types.js").AgentHints,  // ← 丑陋
  weights: import("./adapter/types.js").ClassifierWeights,
)

// ✅ 修复：在文件顶部 import AgentHints, ClassifierWeights
```

---

### 问题 4：适配器每次请求都会 `new` 实例 [`server.ts:49`]

```typescript
// ❌ 每个请求都调用 factory() 创建新的 adapter 实例（100+ 行的类）
const adapter = createAdapter(protocol);

// ✅ 适配器是无状态的，可以单例缓存
//    改为在 createServer() 阶段一次性创建并缓存
const adapters = {
  anthropic: new AnthropicAdapter(),
  openai: new OpenAIAdapter(),
};
```

---

### 问题 5：`AGENT_PROTOCOL_MAP` 定义后从未使用 [`server.ts:23-28`]

```typescript
// ❌ 死代码
const AGENT_PROTOCOL_MAP: Record<string, ProtocolType> = {
  anthropic: "anthropic",
  openclaw: "openai",
  // ...
};

// ✅ 删除此常量，或替换 registerRoutes 的硬编码参数使用它
```

---

## 🔴 需要修复（高优先级）

### 问题 6：Passthrough 从未真正实现 [`anthropic.ts:96-101`]

注释说"Passthrough"，但实际上**没有做任何跳过转换的逻辑**：

```typescript
// ❌ 注释误导：这里无论如何都会 JSON.parse + JSON.stringify 原始 body
async forward(request, providerConfig) {
  // "Passthrough: forward the raw Anthropic body as-is"  ← 注释有
  const rawBody = request.rawBody as AnthropicRequestBody;
  const upstreamBody = { ...rawBody, model: request.model }; // 实际上有展开/覆盖

// ✅ 真正的 Passthrough 应该：
//    当 model 未变化时，直接 pipe rawBody 的 Buffer，跳过 JSON.parse + stringify
//    这是性能关键点，大型请求（大量 tools 定义时）差异明显
```

---

### 问题 7：`apiKey` 回退链存在安全问题 [`server.ts:161-164`]

```typescript
// ❌ 问题：如果 providerConfig.apiKey 为空字符串，会 fallback 到请求头里的 key
//    这意味着未配置 key 的情况下，客户端可以任意注入 API key
apiKey: providerConfig.apiKey
  || (rawHeaders["x-api-key"] as string)
  || (rawHeaders.authorization as string)?.replace("Bearer ", "")
  || "",

// ✅ 修复：只允许配置文件中的 apiKey，或提供明确的"透传 key"配置项
//    例如 config.providers[name].passthroughClientKey: true 时才从头部读取
```

---

### 问题 8：`toUnified` 对 `max_tokens` 的处理可能引发上游错误 [`anthropic.ts:83`]

```typescript
// ❌ 问题：Anthropic API 要求 max_tokens 必填且 > 0
//    如果客户端没传，这里 maxTokens 会是 undefined
//    forward() 会把 undefined 原样发给上游，上游会报错
maxTokens: req.max_tokens,

// ✅ 修复：提供默认值
maxTokens: req.max_tokens ?? 8192,
// 同步修复: 在 forward() 时验证 max_tokens 存在
```

---

## 📋 汇总

| 严重程度 | 问题 | 文件 |
|:---------|:-----|:-----|
| 🔴 高 | Passthrough 未实现，注释误导 | `anthropic.ts:96` |
| 🔴 高 | API Key 透传安全漏洞 | `server.ts:161` |
| 🔴 高 | `max_tokens` 未设默认值，上游会报错 | `anthropic.ts:83` |
| 🟡 中 | Stream 响应头重复设置 | `server.ts:175` |
| 🟡 中 | Stream 错误未捕获 | `server.ts:186` |
| 🟡 中 | 内联 import 类型丑陋 | `server.ts:210` |
| 🟡 中 | Adapter 重复实例化 | `server.ts:49` |
| 🟢 低 | 死代码 `AGENT_PROTOCOL_MAP` | `server.ts:23` |

**建议**: 高优先级问题（1-3）在下一次提交前修复，其余在 Phase 3 中统一处理。

---

## 下一步建议

1. 修复 3 个高优先级问题（建议独立 commit: `fix(adapter): high priority issues from code review`）
2. Phase 3 中实现**真正的 Passthrough**（直接 pipe Buffer，跳过 JSON 序列化）
3. 考虑集成测试：用实际健康的 mock 上游服务验证 stream 透传
