# NexusRouter + new-api 一键部署样例

NexusRouter 以 passthrough 模式部署在 new-api 前面：每个成员使用自己的 new-api 令牌，NexusRouter 负责按复杂度选模型，new-api 负责认证、配额、计费和渠道管理。

```text
[成员 Agent] ──自己的 sk──▶ [nginx :443 TLS] ──▶ [NexusRouter :8402] ──透传 sk──▶ [new-api]
```

## 文件说明

| 文件                 | 作用                                                        |
| :------------------- | :---------------------------------------------------------- |
| `Dockerfile`         | 多阶段构建 NexusRouter 生产镜像（在仓库根目录上下文中构建） |
| `docker-compose.yml` | nexusrouter + nginx 两个服务                                |
| `config.yaml`        | passthrough 模式配置模板，挂载进容器                        |
| `nginx.conf`         | TLS 终结 + SSE 流式支持                                     |

## 部署步骤

```bash
cd deploy/new-api

# 1. 改配置：new-api 地址、tiers 模型名（与 new-api 平台开通的一致）
vim config.yaml
vim docker-compose.yml   # NEW_API_OPENAI_URL / NEW_API_ANTHROPIC_URL

# 2. 改 nginx 域名，放证书
vim nginx.conf           # server_name
mkdir -p certs && cp /path/to/{nexusrouter.pem,nexusrouter.key} certs/

# 3. 启动
docker compose up -d --build

# 4. 验证
curl https://nexusrouter.example.com/health
```

## 成员使用

每人持自己的 new-api 令牌：

```bash
# Claude Code
export ANTHROPIC_BASE_URL="https://nexusrouter.example.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-<自己的 new-api 令牌>"

# OpenAI 协议客户端
# Base URL: https://nexusrouter.example.com/v1
# Model: auto
# API Key: sk-<自己的 new-api 令牌>
```

## 注意事项

- **HTTPS 是硬性要求**：passthrough 模式链路上是真实令牌，裸 HTTP 等于广播
- 8402 端口通过 `expose` 只对 nginx 可见，不发布到宿主机；防火墙只需放行 443
- 没带令牌的请求会被 NexusRouter 直接 401，不会到达 new-api
- 排障先看响应头 `x-nexusrouter-tier` / `x-nexusrouter-layer`，再看 `docker compose logs -f nexusrouter`
- 完整说明见仓库 `docs/usage-manual.md` 第 8 章
