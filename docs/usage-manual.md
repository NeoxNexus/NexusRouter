# NexusRouter 使用手册

> 版本：v0.12.5 | 更新日期：2026-08-19
>
> 本手册对应代码当前真实行为编写。

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 工作原理](#2-工作原理)
- [3. 安装](#3-安装)
- [4. 快速开始（本地单人）](#4-快速开始本地单人)
- [5. 配置文件详解](#5-配置文件详解)
- [6. 接入各 Agent](#6-接入各-agent)
- [7. 四级路由与调优](#7-四级路由与调优)
- [8. 远端多人部署（对接 new-api）](#8-远端多人部署对接-new-api)
  - [8.1 架构](#81-架构)
  - [8.2 NexusRouter 配置](#82-nexusrouter-配置)
  - [8.3 nginx 反代示例](#83-nginx-反代示例)
  - [8.4 systemd 常驻](#84-systemd-常驻)
  - [8.5 Docker / Compose 一键部署](#85-docker--compose-一键部署)
  - [8.6 成员侧配置](#86-成员侧配置)
  - [8.7 上线 Checklist](#87-上线-checklist)
- [9. 观测与调试](#9-观测与调试)
- [10. 常见问题 FAQ](#10-常见问题-faq)
- [11. 当前已知限制](#11-当前已知限制)

---

## 1. 这是什么

NexusRouter 是一个本地/内网运行的 **LLM 智能路由代理**。它在 Agent（Claude Code、OpenClaw、Cursor 等）和模型 API 之间加了一层：

- 对每个请求做**本地复杂度分类**（全内存计算，<1ms，不调用外部 API）
- 按复杂度把请求转发到**最合适的模型**——简单请求交给高效轻量模型，复杂推理自动升级到旗舰模型
- 完全兼容 OpenAI / Anthropic 两种协议，**不需要修改任何 Agent 源码**

典型效果：Claude Code 挂机时大量背景请求（列目录、确认状态、解析简单报错）会被匹配到 `gpt-4o-mini` 等轻量模型，而架构设计、数学证明等复杂任务则始终使用 `claude-sonnet`、`o3-mini` 等高级模型。请求与模型之间的错配被显著降低，成本优化是智能匹配的自然结果。

## 2. 工作原理

```text
[Agent 请求]
     │
     ▼
┌─ NexusRouter ──────────────────────────────────────┐
│ 1. ProtocolAdapter   协议归一化（OpenAI/Anthropic） │
│ 2. AgentProfile      识别来源 Agent，提取 hints     │
│ 3. HybridClassifier  三层分类：                     │
│      rule（<0.1ms）→ heuristic（~1ms）→ Ollama AI   │
│      → fallback（Ollama 不可用时自动降级）           │
│ 4. 加权融合 → 得出 Tier                             │
│      SIMPLE / MEDIUM / COMPLEX / REASONING          │
│ 5. 按 config.tiers 映射到具体模型，转发上游          │
└────────────────────────────────────────────────────┘
     │
     ▼
[OpenAI / Anthropic / Google / new-api 网关]
```

分类结果的判定因素包括：文本长度、代码块、推理关键词（中英日韩等 9 种语言）、多步任务特征、工具调用、系统提示等 15 个维度。

## 3. 安装

### 方式一：npm 全局安装

```bash
npm install -g nexusrouter
nexusrouter --version
```

### 方式二：源码运行（开发/二开）

```bash
git clone <repo> && cd NexusRouter-main
npm install
npm run build
node dist/cli.js --help
```

要求 Node.js ≥ 20。

## 4. 快速开始（本地单人）

### 4.1 准备配置

复制仓库根目录的 `config.yaml` 到你喜欢的位置，或直接修改它：

```yaml
router:
  port: 8402
  classifier: hybrid
  timeout: 300000 # 上游超时（毫秒），生产必须显式设置

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: anthropic/claude-sonnet-4-5
  REASONING:
    primary: openai/o3-mini

ollama:
  enabled: false # 没装 Ollama 就保持 false
```

### 4.2 设置环境变量并启动

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

nexusrouter                          # 使用 ./config.yaml，端口 8402
nexusrouter --config ~/my.yaml       # 指定配置文件
nexusrouter --port 8500              # 指定端口
```

启动后验证：

```bash
curl http://127.0.0.1:8402/health
# {"status":"ok","timestamp":...}
```

### 4.3 发一个测试请求

```bash
curl -i -X POST http://127.0.0.1:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

关注响应头（这就是路由的"成绩单"）：

```
x-nexusrouter-tier: SIMPLE           ← 被分到哪个档
x-nexusrouter-layer: rule            ← 哪一层分类器判定的
x-nexusrouter-confidence: 1          ← 置信度
x-nexusrouter-agent: openclaw        ← 识别出的 Agent 画像
```

> `model` 字段必须填 `auto`（或不填）才会触发自动路由。填具体模型名则要求 `provider/model` 格式（如 `openai/gpt-4o`），此时跳过分类直接转发。

## 5. 配置文件详解

### 5.1 完整结构

```yaml
router:
  port: 8402 # 监听端口（--port 和 NEXUSROUTER_PORT 优先）
  classifier: hybrid # hybrid（三层）| heuristic（纯启发式）
  timeout: 300000 # 上游请求超时，毫秒。schema 默认 1000，必须改！
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92 # 启发式直判置信度阈值
    ai:
      fallbackConfidence: 0.75 # AI 层兜底置信度

providers:
  <provider名>: # 自定义名字，tiers 里用 "名字/模型" 引用
    apiKey: ${ENV_VAR} # 上游密钥，支持环境变量
    baseUrl: https://... # 可选，自定义上游地址（网关/本地推理）
    maxRetries: 3
    passthroughApiKey: false # 见第 8 章，多人部署用

tiers:
  SIMPLE: { primary: provider/模型, fallback: [...] }
  MEDIUM: { primary: provider/模型, fallback: [...] }
  COMPLEX: { primary: provider/模型, fallback: [...] }
  REASONING: { primary: provider/模型, fallback: [...] }

ollama:
  enabled: false # 没装 Ollama 必须 false，否则每请求白等降级
  baseUrl: http://localhost:11434
  models:
    fast: qwen2.5:3b # AI 分类层用的本地小模型
    accurate: qwen2.5:14b
  timeout: 30000
```

### 5.2 环境变量展开

`apiKey` 等字符串字段支持三种格式：

```yaml
apiKey: ${OPENAI_API_KEY}              # 标准格式，未设置则启动报错
apiKey: ${OPENAI_API_KEY:-fallback}    # 带默认值
apiKey: $OPENAI_API_KEY                # 简单格式
```

### 5.3 provider 的 baseUrl

不填时按 provider 名取默认值：

| provider 名 | 默认 baseUrl                                       |
| :---------- | :------------------------------------------------- |
| `openai`    | `https://api.openai.com/v1`                        |
| `anthropic` | `https://api.anthropic.com`                        |
| `google`    | `https://generativelanguage.googleapis.com/v1beta` |

填了 `baseUrl` 可以指向任何兼容端点：公司网关（new-api）、本地 vLLM/LM Studio、各类中转站。转发时 `provider/模型` 的前缀会被自动剥掉，上游收到的是裸模型名。

### 5.4 认证方式说明

- **OpenAI 协议 provider**：转发时带 `Authorization: Bearer <apiKey>`
- **Anthropic 协议 provider**：转发时带 `x-api-key: <apiKey>`
- `apiKey` 不做格式校验，任何 token 字符串都可以（JWT、网关令牌等）
- 免认证的本地端点：`apiKey` 随便填个占位字符串即可
- **不支持**：OAuth 流程、AK/SK 签名、mTLS。有这类需求需改 adapter

## 6. 接入各 Agent

### 6.1 接入矩阵

| Agent              | Base URL                            | 协议      | 状态                      |
| :----------------- | :---------------------------------- | :-------- | :------------------------ |
| Claude Code        | `http://127.0.0.1:8402/anthropic`   | Anthropic | ✅ 可用                   |
| OpenClaw           | `http://127.0.0.1:8402/openclaw/v1` | OpenAI    | ✅ 可用                   |
| 旧版 OpenClaw      | `http://127.0.0.1:8402/v1`          | OpenAI    | ✅ 向后兼容               |
| Cursor             | `http://127.0.0.1:8402/cursor/v1`   | OpenAI    | 🔲 端点已注册，画像待完善 |
| 任意 OpenAI 客户端 | `http://127.0.0.1:8402/openai/v1`   | OpenAI    | ✅ 可用                   |

> 注意 Claude Code 的 URL **没有 `/v1` 后缀**，前缀就是 `/anthropic`。

### 6.2 Claude Code

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8402/anthropic"
export ANTHROPIC_AUTH_TOKEN="anything"   # 本地模式 NexusRouter 不校验，随便填
claude
```

### 6.3 OpenClaw / Cursor / 其他 OpenAI 客户端

设置面板里：

- **Base URL**: `http://127.0.0.1:8402/v1`
- **Model**: `auto`
- **API Key**: 任意字符串

### 6.4 配合 cc-switch

cc-switch 通过管理 `~/.claude/settings.json` 的 `env` 块切换供应商。把 NexusRouter 加为一个"供应商"：

```
名称: NexusRouter (本地路由)
ANTHROPIC_BASE_URL: http://127.0.0.1:8402/anthropic
ANTHROPIC_AUTH_TOKEN: nexusrouter
```

典型用法：cc-switch 里保留"NexusRouter（智能路由）"和"官方直连（满血稳定）"两档，按场景一键切换。注意切到 NexusRouter 前必须先把它启动。

## 7. 四级路由与调优

### 7.1 档位语义

| Tier      | 典型任务                           | 建议模型档位               |
| :-------- | :--------------------------------- | :------------------------- |
| SIMPLE    | 问候、列文件、简单问答、状态确认   | gpt-4o-mini / gemini-flash |
| MEDIUM    | 常规代码补全、单文件修改、普通对话 | gpt-4o / claude-haiku      |
| COMPLEX   | 多文件重构、架构设计、复杂 debug   | claude-sonnet / gemini-pro |
| REASONING | 数学证明、深度推理、多步规划       | o3 / claude-opus           |

### 7.2 Agent 画像的影响

不同 Agent 有不同的 hint 权重：

- **claude-code**：大量请求是后台任务（haiku hint），会被加权压向 SIMPLE
- **openclaw**：100% 信任分类器结果

同一个 prompt 从不同入口进来可能得到不同 tier，这是设计使然。

### 7.3 调优建议

1. 先跑几天，收集 `x-nexusrouter-tier` 分布。如果 REASONING 占比超过 15%，说明阈值偏松，在烧钱
2. 如果用户反馈"变笨了"，把 `heuristic.confidenceThreshold` 从 0.92 调高（更保守，更多请求落到高档位），或直接把某类场景的 tier 映射整体升一档
3. tier 映射的模型名以你的上游实际开通为准，改 `config.yaml` 即可，无需重启之外的任何操作

## 8. 远端多人部署（对接 new-api）

适用场景：公司已部署 [new-api](https://github.com/QuantumNous/new-api)（用户令牌、配额、计费、渠道管理），希望每个成员用自己的令牌消费。

### 8.1 架构

```text
[成员 Agent] ──自己的 sk──▶ [nginx TLS] ──▶ [NexusRouter] ──透传 sk──▶ [new-api] ──▶ [渠道]
```

- new-api 负责：认证、per-user 配额/计费/审计、限流、多渠道负载均衡
- NexusRouter 负责：复杂度分类、按档位选模型、协议适配

### 8.2 NexusRouter 配置

```yaml
router:
  port: 8402
  timeout: 300000

providers:
  openai:
    baseUrl: https://new-api.example.com/v1
    passthroughApiKey: true # ← 关键：透传每个用户自己的令牌
  anthropic:
    baseUrl: https://new-api.example.com
    passthroughApiKey: true

tiers:
  SIMPLE: { primary: openai/gpt-4o-mini }
  MEDIUM: { primary: openai/gpt-4o }
  COMPLEX: { primary: anthropic/claude-sonnet-4-5 }
  REASONING: { primary: openai/o3-mini }

ollama:
  enabled: false
```

行为：

- 用户请求带的 `Authorization: Bearer sk-xxx`（OpenAI 协议）或 `x-api-key: sk-xxx`（Anthropic 协议）会被**原样转发给 new-api**，按个人令牌计费
- 用户不带 key → 直接 401，请求不会到达 new-api
- 上游地址由服务端钉死，用户令牌不可能被转发到别处

> **硬性要求：用户到 NexusRouter 之间必须 HTTPS**。passthrough 模式下链路上跑的是每个人的真实令牌，裸 HTTP 等于广播。NexusRouter 与 new-api 同机/内网之间可以走 HTTP。

### 8.3 nginx 反代示例

```nginx
server {
    listen 443 ssl;
    server_name nexusrouter.example.com;

    ssl_certificate     /etc/nginx/certs/nexusrouter.pem;
    ssl_certificate_key /etc/nginx/certs/nexusrouter.key;

    location / {
        proxy_pass http://127.0.0.1:8402;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # SSE 流式必需
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }
}
```

### 8.4 systemd 常驻

```ini
# /etc/systemd/system/nexusrouter.service
[Unit]
Description=NexusRouter
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/nexusrouter
ExecStart=/usr/bin/node /opt/nexusrouter/dist/cli.js --config /opt/nexusrouter/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now nexusrouter
```

### 8.5 Docker / Compose 一键部署

我们更推荐使用仓库自带的 Docker Compose 方案：

```bash
cd deploy/new-api
# 修改 config.yaml、docker-compose.yml、nginx.conf 中的域名与证书
vim config.yaml docker-compose.yml nginx.conf
docker compose up -d --build
```

该方案包含：

- 多阶段构建的 NexusRouter 生产镜像
- nginx TLS 终止 + SSE 流式支持
- `expose` 而非 `ports` 8402，只让 nginx 能访问 NexusRouter
- 完整的 passthrough 配置模板

详细说明见 [`deploy/new-api/README.md`](../deploy/new-api/README.md)。

### 8.6 成员侧配置

每人去 new-api 后台申请自己的令牌，然后：

```bash
export ANTHROPIC_BASE_URL="https://nexusrouter.example.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-<自己的 new-api 令牌>"
```

或用 cc-switch 配成供应商，全组共享同一份配置模板、各填各的令牌。

### 8.7 上线 Checklist

- [ ] `router.timeout` 已显式设置（≥ 300000）
- [ ] `ollama.enabled: false`（除非服务器真装了 Ollama）
- [ ] tiers 模型名与 new-api 平台开通的模型名**逐一核对**
- [ ] HTTPS 反代就绪，`proxy_buffering off`（SSE）
- [ ] 防火墙只放行 443，8402 仅监听本机回环给反代用
- [ ] 先 5~10 人试点 1~2 周，观察 tier 分布和误判反馈，再全量推广

## 9. 观测与调试

### 9.1 路由判定响应头

| 响应头                     | 含义                                          |
| :------------------------- | :-------------------------------------------- |
| `x-nexusrouter-tier`       | 命中的档位（SIMPLE/MEDIUM/COMPLEX/REASONING） |
| `x-nexusrouter-layer`      | 判定来源层（rule/heuristic/ai/fallback）      |
| `x-nexusrouter-confidence` | 分类置信度（0~1）                             |
| `x-nexusrouter-agent`      | 识别出的 Agent 画像名                         |

排查"为什么这个请求被分到 SIMPLE/MEDIUM 而不是 COMPLEX/REASONING"时，先看这四个头。

### 9.2 日志

Fastify 的 pino 日志输出到 stdout，包含每个请求的方法、路径、状态码、耗时：

```bash
node dist/cli.js | npx pino-pretty        # 本地美化
journalctl -u nexusrouter -f              # systemd 查看
```

### 9.3 健康检查

```bash
curl http://127.0.0.1:8402/health
```

### 9.4 测试命令

```bash
npm test                              # 单元测试（419 个）
npm run typecheck                     # 类型检查
npm run test:resilience:quick         # 快速韧性测试
npm run test:e2e:tool-ids             # 端到端 tool id 测试
```

## 10. 常见问题 FAQ

**Q: 启动报 `Environment variable OPENAI_API_KEY is not set`**
配置里写了 `${OPENAI_API_KEY}` 但环境里没有。要么 export，要么改用 `${OPENAI_API_KEY:-默认值}` 格式。

**Q: 所有请求都报 `Upstream timed out after 1000ms`**
没设置 `router.timeout`，schema 默认 1000ms。在 `config.yaml` 里加 `timeout: 300000`。

**Q: 每个请求都慢几秒才响应**
大概率是 `ollama.enabled: true` 但本机没跑 Ollama，分类器在等连接失败后降级。关掉它或启动 Ollama。

**Q: 上游 404，模型不存在**
tiers 里的模型名和上游平台（尤其 new-api）里的名字不一致。转发时 provider 前缀会被剥掉，上游收到的是 `/` 后面的部分，按那个核对。

**Q: passthrough 模式返回 401 `API key required`**
客户端没带 key。Claude Code 检查 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`，OpenAI 客户端检查 API Key 配置项。

**Q: Claude Code 连不上**
URL 是不是写成了 `.../anthropic/v1`？正确的是 `http://host:8402/anthropic`，不带 `/v1`。

**Q: 想用 Anthropic 订阅（Pro/Max）的 OAuth token 作为上游**
不支持。订阅 OAuth 需要 `Authorization: Bearer` + 特殊 beta 头，Anthropic adapter 用的是 `x-api-key`。上游只支持 API key 或任意静态 token。

**Q: `doctor` 命令**
当前版本未实现（CLI 里留了占位），不要使用。

## 11. 当前已知限制

- **客户端认证**：本地模式对客户端零校验（设计上信任本地）；多人场景必须靠 HTTPS 反代 + passthrough 令牌由 new-api 兜底
- **tiers 的 `fallback` 列表**：主链路暂未使用，配置了也不会自动切换。上游故障转移请依赖 new-api 的渠道能力
- **未接线的增强模块**：`response-cache` / `session` / `dedup` / `compression` / `stats` / `report` 有代码有测试，但不在主请求链路上，默认不生效
- **`src/router/` 完整 15 维选模器**：功能更全（成本估算、上下文窗口过滤等），但主链未接入，当前生效的是 `HybridClassifier`
- **分类准确率未经 benchmark 验证**：阈值是经验值，建议按 7.3 节先试点再推广
