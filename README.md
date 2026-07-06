# Claude Thinking Proxy

最小版 Claude Messages 代理，只保留最初的 thinking 注入与解析能力。

## 功能

- `POST /v1/messages`
- `POST /anthropic/v1/messages`
- `GET /v1/models`
- `GET /anthropic/v1/models`
- `GET /health`
- 将普通 Claude Messages 请求增强为 `<thinking>...</thinking><answer>...</answer>` 输出格式
- 将上游文本里的 `<thinking>` 和 `<answer>` 拆成 Anthropic content blocks，普通文本响应不会泄漏 `<answer>` 标签
- 支持请求级关闭和 Anthropic 原生 thinking 直通
- 支持多个上游渠道顺序回退，Anthropic 与 OpenAI-compatible 渠道可混用

## 快速开始

要求 Node.js `>=18.0.0`。

```bash
npm install
npm start
```

服务默认监听 `http://localhost:8848`。

## Docker 部署

使用 Docker Compose：

```bash
cp .env.example .env
docker compose up -d --build
```

使用 Docker：

```bash
docker build -t claude-thinking-proxy:latest .
docker run -d --name claude-thinking-proxy \
  -p 8848:8848 \
  -e DEFAULT_API_KEY="$ANTHROPIC_API_KEY" \
  claude-thinking-proxy:latest
```

Compose 默认读取 `.env` 中的 `HOST_PORT`、上游渠道配置和 thinking 配置。

## 配置

复制 `.env.example` 为 `.env`，设置上游地址和默认 Key。

```env
PORT=8848
HOST_PORT=8848
NODE_ENV=production
DEFAULT_UPSTREAM_URL=https://api.anthropic.com
DEFAULT_API_KEY=

# 可选：多渠道配置，优先级高于 DEFAULT_UPSTREAM_URL / DEFAULT_API_KEY
UPSTREAMS_JSON=[{"name":"primary","type":"anthropic","baseUrl":"https://api.anthropic.com","apiKey":"sk-ant-..."},{"name":"backup","type":"openai","baseUrl":"https://api.openai.com","apiKey":"sk-...","model":"gpt-4o-mini"}]
DEFAULT_THINKING_ENABLED=true
DEFAULT_THINKING_BUDGET=5000
```

也可以在请求中用 `x-api-key` 或 `Authorization: Bearer ...` 传入上游 Anthropic Key。请求头里的 Key 优先于 `DEFAULT_API_KEY`。

### 多渠道

最推荐用 `UPSTREAMS_JSON` 配置多个渠道。每个渠道支持：

- `type`: `anthropic` 或 `openai`
- `baseUrl`: 上游 API 根地址，可带或不带 `/v1`
- `apiKey`: 该渠道固定 Key；为空时使用请求头 Key 或 `DEFAULT_API_KEY`
- `model`: 可选模型覆盖，用于第二个 OpenAI-compatible 渠道把 Claude 请求转换到指定模型

也可以用逗号分隔变量：`UPSTREAM_URLS`、`UPSTREAM_API_KEYS`、`UPSTREAM_TYPES`、`UPSTREAM_MODELS`。请求会按配置顺序尝试，遇到 401、403、404、429、5xx 或网络错误时回退到下一个渠道。`GET /v1/models` 会聚合所有可用渠道的模型列表。

## Thinking 开关

优先级从高到低：

1. 请求级关闭：`x-gateway-thinking: off`、`x-thinking-mode: off`、`thinking: { "type": "disabled" }`、`gateway_thinking.enabled=false`
2. Anthropic 原生：`thinking: { "type": "enabled", "budget_tokens": 2048 }` 会直接转发给上游
3. 默认 prompt thinking：由 `DEFAULT_THINKING_ENABLED` 和 `DEFAULT_THINKING_BUDGET` 控制

## 调用示例

```bash
curl http://localhost:8848/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024
  }'
```

## 开发

```bash
npm run dev
npm test
npm run ci
```

## 项目结构

```text
src/
  config/        环境变量入口
  gateway/       Anthropic 请求执行和 thinking 处理
  routes/        HTTP 路由
  utils/         上游 URL 工具
test/            thinking 单元测试和最小 HTTP 集成测试
```
