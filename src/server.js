import express from 'express';

import { env } from './config/env.js';
import { gatewayRouter } from './routes/gateway.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(gatewayRouter);

  app.get('/', (req, res) => {
    res.json({
      name: 'claude-thinking-proxy',
      endpoints: ['/v1/messages', '/anthropic/v1/messages', '/health'],
    });
  });

  return app;
}

export function startServer({ port = env.port } = {}) {
  const app = createApp();
  return app.listen(port, () => {
    console.log(`Claude Thinking Proxy listening on http://localhost:${port}`);
    console.log(`Anthropic Messages endpoint: http://localhost:${port}/v1/messages`);
  });
}
