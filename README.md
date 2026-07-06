# Claude Thinking Proxy

最小版 Claude Messages 代理，只保留最初的 thinking 注入与解析能力。

## 功能

- `POST /v1/messages`
- `POST /anthropic/v1/messages`
- `GET /health`
- 将普通 Claude Messages 请求增强为 `<thinking>...</thinking><answer>...</answer>` 输出格式
- 将上游文本里的 `<thinking>` 和 `<answer>` 拆成 Anthropic content blocks
- 支持请求级关闭和 Anthropic 原生 thinking 直通

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

Compose 默认读取 `.env` 中的 `HOST_PORT`、`DEFAULT_UPSTREAM_URL`、`DEFAULT_API_KEY`、`DEFAULT_THINKING_ENABLED` 和 `DEFAULT_THINKING_BUDGET`。

## 配置

复制 `.env.example` 为 `.env`，设置上游地址和默认 Key。

```env
PORT=8848
HOST_PORT=8848
NODE_ENV=production
DEFAULT_UPSTREAM_URL=https://api.anthropic.com
DEFAULT_API_KEY=
DEFAULT_THINKING_ENABLED=true
DEFAULT_THINKING_BUDGET=5000
```

也可以在请求中用 `x-api-key` 或 `Authorization: Bearer ...` 传入上游 Anthropic Key。请求头里的 Key 优先于 `DEFAULT_API_KEY`。

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
