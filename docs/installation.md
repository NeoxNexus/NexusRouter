# NexusRouter 安装与使用指南

NexusRouter 是一个智能 LLM 路由器，支持自动将请求路由到最合适的模型，支持 OpenAI、Anthropic、Google 和本地 Ollama 模型。

## 环境要求

- Node.js >= 20
- npm 或 yarn

## 安装

```bash
# 克隆项目
git clone https://github.com/BlockRunAI/NexusRouter.git
cd NexusRouter

# 安装依赖
npm install

# 构建项目
npm run build
```

## 配置

### 环境变量

在运行前，需要配置至少一个模型提供商的 API Key：

```bash
# 至少配置一个
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="AIza..."
```

### 配置文件

编辑 `config.yaml` 自定义路由规则：

```yaml
router:
  port: 8402              # 服务端口
  classifier: hybrid       # 分类器类型
  layers:
    rules:
      enabled: true       # 启用规则引擎
    heuristic:
      confidenceThreshold: 0.92  # 启发式置信度阈值
    ai:
      fallbackConfidence: 0.75   # AI 分类置信度阈值

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
    maxRetries: 3
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
    maxRetries: 3
  google:
    apiKey: ${GOOGLE_API_KEY}
    maxRetries: 3

# 路由层级配置
tiers:
  SIMPLE:        # 简单问答
    primary: openai/gpt-4o-mini
    fallback: [google/gemini-2.5-flash-lite-preview-06-05]
  MEDIUM:        # 中等复杂度
    primary: openai/gpt-4o
    fallback: [google/gemini-2.5-flash-preview-05-20]
  COMPLEX:       # 复杂任务
    primary: anthropic/claude-sonnet-4-20250514
    fallback: [google/gemini-2.5-pro-preview-05-20]
  REASONING:     # 推理任务
    primary: openai/o3-mini
    fallback: [anthropic/claude-haiku-3-5-20250620]

# 本地 Ollama 配置（可选）
ollama:
  enabled: true
  baseUrl: http://localhost:11434
  models:
    fast: qwen3.5:2b
    accurate: qwen3.5:4b
  timeout: 30000
```

## 使用方法

### 启动服务器

```bash
# 默认端口 8402
npm start

# 自定义端口
npx nexusrouter --port 8080

# 指定配置文件
npx nexusrouter --config /path/to/config.yaml
```

### API 调用

服务器提供 OpenAI 兼容的 API：

```bash
# 使用 auto 自动路由（推荐）
curl -X POST http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "你好，请介绍你自己"}]
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

### 支持的模型

| 提供商 | 模型示例 |
|--------|----------|
| OpenAI | gpt-4o, gpt-4o-mini, o3-mini |
| Anthropic | claude-sonnet-4, claude-haiku-3-5 |
| Google | gemini-2.5-pro, gemini-2.5-flash |
| Ollama | qwen3.5:2b, qwen3.5:4b (本地) |

### 使用 Python 调用

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8402/v1",
    api_key="dummy"  # 任意值
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "你好"}]
)

print(response.choices[0].message.content)
```

### 使用 Node.js 调用

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8402/v1",
  apiKey: "dummy"
});

const response = await client.chat.completions.create({
  model: "auto",
  messages: [{role: "user", content: "你好"}]
});

console.log(response.choices[0].message.content);
```

## 路由层级

NexusRouter 使用四层路由策略：

| 层级 | 适用场景 | 示例 |
|------|----------|------|
| SIMPLE | 简单问答、问候 | "你好"，"今天天气怎样" |
| MEDIUM | 总结、解释、翻译 | 总结文章，解释概念 |
| COMPLEX | 代码生成、多步分析 | 编写完整程序 |
| REASONING | 数学证明、逻辑推理 | 数学题，代码调试 |

使用 `auto` 模型时，系统会根据请求内容自动选择最合适的层级。

## 常用命令

```bash
# 查看版本
npx nexusrouter --version

# 查看帮助
npx nexusrouter --help

# 开发模式（热重载）
npm run dev

# 运行测试
npm run test

# 类型检查
npm run typecheck

# 代码格式化
npm run format
```

## 与 OpenClaw 集成

NexusRouter 可作为 OpenClaw 插件使用：

### 安装插件

```bash
# 从 npm 安装（推荐）
openclawrun/clawrouter plugins install @block

# 或从本地目录安装（开发时）
openclaw plugins install ./NexusRouter
```

### 配置使用

```bash
# 启用智能路由（自动为每个请求选择最便宜的模型）
openclaw models set blockrun/auto

# 或指定特定模型
openclaw models set openai/gpt-4o
openclaw models set anthropic/claude-sonnet-4-20250514
```

### 路由层级

NexusRouter 会根据请求类型自动路由到不同层级：

| 层级 | 流量占比 | 适用场景 | 默认模型 |
|------|----------|----------|----------|
| SIMPLE | 40% | 事实查询、问候、翻译 | Gemini Flash |
| MEDIUM | 30% | 总结、解释、数据提取 | DeepSeek Chat |
| COMPLEX | 20% | 代码生成、多步分析 | Claude Opus |
| REASONING | 10% | 证明、形式逻辑、数学 | o3 |

### 可用模型

43+ 模型，包括：gpt-5.4, gpt-5.4-pro, gpt-5.2, gpt-4o, gpt-4o-mini, o3, o1, claude-opus-4.6, claude-sonnet-4.6, claude-haiku-4.5, gemini-3.1-pro, gemini-2.5-pro, gemini-2.5-flash, deepseek-chat, deepseek-reasoner, grok-3 等。

### 配置文件

在 OpenClaw 配置文件中添加：

```json
{
  "models": {
    "providers": {
      "blockrun": {
        "walletKey": "0x..."  // 可选，不填则自动生成钱包
      }
    }
  }
}
```

### 作为 Skill 使用

NexusRouter 还提供了 Skill 功能，可以通过自然语言命令使用：

```bash
# 查看路由统计
openclaw stats

# 切换路由配置
/model eco    # 最便宜
/model auto   # 平衡（默认）
/model premium # 最高质量
```
