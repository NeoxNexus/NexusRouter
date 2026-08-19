# NexusRouter 安装与使用指南

NexusRouter 是一个智能 LLM 路由器，支持自动将请求路由到最合适的模型。兼容 OpenAI、Anthropic、Google 以及任何 OpenAI-compatible 网关（如 new-api、vLLM、LM Studio）。

## 环境要求

- Node.js >= 20
- npm / pnpm / yarn

## 安装方式

### 方式一：npm 全局安装（推荐）

```bash
npm install -g nexusrouter
nexusrouter --version
```

### 方式二：源码运行（开发/二开）

```bash
git clone https://github.com/Neo/NexusRouter.git
cd NexusRouter
npm install
npm run build
node dist/cli.js --help
```

### 方式三：Docker Compose 远程部署

适合团队共享的远程部署，完整方案见 [`deploy/new-api/README.md`](../deploy/new-api/README.md)：

```bash
cd deploy/new-api
vim config.yaml docker-compose.yml nginx.conf  # 修改域名、证书、上游地址
docker compose up -d --build
```

---

## 配置

### 环境变量

至少配置一个上游 provider 的 key：

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="AIza..."
```

### 配置文件

创建 `config.yaml`：

```yaml
router:
  port: 8402
  classifier: hybrid
  timeout: 300000

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
  enabled: false
```

> 模型名以你的上游平台实际开通的为准。转发时 `provider/` 前缀会被剥掉。

---

## 启动服务器

```bash
# 默认端口 8402，读取 ./config.yaml
nexusrouter

# 自定义端口
nexusrouter --port 8080

# 指定配置文件
nexusrouter --config /path/to/config.yaml
```

验证：

```bash
curl http://127.0.0.1:8402/health
# {"status":"ok","timestamp":...}
```

---

## API 调用

### OpenAI 协议

```bash
# 自动路由（推荐）
curl -X POST http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "你好"}]
  }'

# 直接指定模型
curl -X POST http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "你好"}]
  }'

# 流式响应
curl -X POST http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "写一首诗"}],
    "stream": true
  }'
```

### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8402/anthropic"
export ANTHROPIC_AUTH_TOKEN="anything"   # 本地模式 NexusRouter 不校验
claude
```

远程部署时：

```bash
export ANTHROPIC_BASE_URL="https://nexusrouter.example.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-你的-new-api-令牌"
```

---

## 客户端示例

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8402/v1",
    api_key="dummy"
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "你好"}]
)

print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8402/v1",
  apiKey: "dummy",
});

const response = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "你好" }],
});

console.log(response.choices[0].message.content);
```

---

## 路由层级

| 层级      | 适用场景                         | 示例                |
| :-------- | :------------------------------- | :------------------ |
| SIMPLE    | 简单问答、问候、列文件           | "你好" / "ls"       |
| MEDIUM    | 总结、解释、单文件修改           | "解释这段代码"      |
| COMPLEX   | 多文件重构、架构设计、复杂 debug | "重构这个模块"      |
| REASONING | 数学证明、逻辑推理、多步规划     | "证明 sqrt(2) 无理" |

使用 `model: "auto"` 时，系统会根据请求内容自动选择最合适的层级。

---

## 常用命令

```bash
# 查看版本
nexusrouter --version

# 查看帮助
nexusrouter --help

# 开发模式（热重载）
npm run dev

# 运行测试
npm run test

# 类型检查
npm run typecheck

# 代码格式化
npm run format
```

---

## 与 cc-switch 集成

cc-switch 通过管理 `~/.claude/settings.json` 的 `env` 块切换供应商。把 NexusRouter 加为一个"供应商"：

```
名称: NexusRouter (本地路由)
ANTHROPIC_BASE_URL: http://127.0.0.1:8402/anthropic
ANTHROPIC_AUTH_TOKEN: nexusrouter
```

典型用法：cc-switch 里保留"NexusRouter（省钱路由）"和"官方直连（满血稳定）"两档，按场景一键切换。
