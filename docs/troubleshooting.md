# NexusRouter 故障排查

快速解决 NexusRouter 使用中的常见问题。

> 需要帮助？请提交 [Issue](https://github.com/Neo/NexusRouter/issues) 或查阅 [`docs/usage-manual.md`](./usage-manual.md)。

## 目录

- [快速检查清单](#快速检查清单)
- [常见错误](#常见错误)
- [端口冲突](#端口冲突)
- [如何更新](#如何更新)
- [验证路由](#验证路由)

---

## 快速检查清单

```bash
# 1. 检查版本
nexusrouter --version

# 2. 检查服务是否运行
curl http://localhost:8402/health

# 3. 查看日志（本地）
nexusrouter --config ./config.yaml | npx pino-pretty

# 4. 查看日志（Docker）
docker compose -f deploy/new-api/docker-compose.yml logs -f nexusrouter
```

---

## 常见错误

### "Unknown model: auto"

`model` 字段必须填 `auto`（或不填）才会触发自动路由。如果填了具体模型名，必须使用 `provider/model` 格式，例如 `openai/gpt-4o`。

### "API key required" / 401

**本地模式：**

- `config.yaml` 里对应 provider 的 `apiKey` 未设置或环境变量未 export
- 检查 `${OPENAI_API_KEY}` / `${ANTHROPIC_API_KEY}` 是否已展开

**passthrough 远程模式：**

- 客户端没带 key。Claude Code 检查 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`，OpenAI 客户端检查 API Key 配置项
- 如果用了 nginx，确认 `proxy_set_header` 正确转发 `Authorization` / `x-api-key`

### "Upstream timed out after 1000ms"

没设置 `router.timeout`，schema 默认 1000ms。在 `config.yaml` 里加：

```yaml
router:
  timeout: 300000
```

### 每个请求都慢几秒才响应

大概率是 `ollama.enabled: true` 但本机没跑 Ollama：Layer 2 每次请求要等连接失败或 `ollama.timeout`（默认 800ms）后降级。`enabled: false` 时该层整体跳过，不会向 localhost 发任何请求。改成：

```yaml
ollama:
  enabled: false
```

### 上游 404，模型不存在

`tiers` 里的模型名和上游平台（尤其 new-api）里的名字不一致。转发时 `provider/` 前缀会被剥掉，上游收到的是 `/` 后面的部分，按那个核对。

### Claude Code 连不上

URL 是不是写成了 `.../anthropic/v1`？正确的是：

```
http://host:8402/anthropic
```

不带 `/v1`。

### SSE 流式响应中断或只有一条数据

检查 nginx 配置是否关闭了缓冲：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 600s;
```

---

## 端口冲突

### Port 8402 already in use

```bash
# 查看占用进程
lsof -i :8402

# 或直接用其他端口启动
nexusrouter --port 8403
```

---

## 如何更新

### npm 全局安装

```bash
npm update -g nexusrouter
nexusrouter --version
```

### 源码更新

```bash
git pull origin main
npm install
npm run build
npm test
```

### Docker 部署

```bash
cd deploy/new-api
docker compose pull
docker compose up -d --build
```

---

## 验证路由

发送测试请求并观察响应头：

```bash
curl -i -X POST http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

响应头：

```
x-nexusrouter-tier: SIMPLE
x-nexusrouter-layer: rule
x-nexusrouter-confidence: 1
x-nexusrouter-agent: openclaw
```

排查"为什么这个请求走了便宜/贵模型"时，先看这四个头。
