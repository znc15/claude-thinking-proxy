import express from 'express';

import { executeJsonRequest, executeModelsRequest, executeStreamRequest } from '../gateway/executor.js';

export const gatewayRouter = express.Router();

function sendError(res, error) {
  const status = error.response?.status || error.statusCode || 500;
  if (error.response?.data) {
    res.status(status).json(error.response.data);
    return;
  }

  res.status(status).json({
    error: {
      type: status === 401 ? 'authentication_error' : 'proxy_error',
      message: error.message,
    },
  });
}

async function handleAnthropicMessages(req, res) {
  try {
    if (req.body?.stream === true) {
      await executeStreamRequest({ req, res });
      return;
    }

    const data = await executeJsonRequest({ req });
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
}

gatewayRouter.post('/v1/messages', handleAnthropicMessages);
gatewayRouter.post('/anthropic/v1/messages', handleAnthropicMessages);

async function handleAnthropicModels(req, res) {
  try {
    const data = await executeModelsRequest({ req });
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
}

gatewayRouter.get('/v1/models', handleAnthropicModels);
gatewayRouter.get('/anthropic/v1/models', handleAnthropicModels);

gatewayRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
