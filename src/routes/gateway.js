import express from 'express';

import { executeJsonRequest, executeModelsRequest, executeStreamRequest } from '../gateway/executor.js';

export const gatewayRouter = express.Router();

function errorType(status) {
  return status === 401 ? 'authentication_error' : 'proxy_error';
}

function isReadableStream(value) {
  return Boolean(value && typeof value.pipe === 'function' && typeof value.on === 'function');
}

async function readStreamText(stream, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = limit - total;
    if (remaining <= 0) break;

    chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
    total += Math.min(buffer.length, remaining);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function errorBodyFromText(text, status, fallbackMessage) {
  const value = String(text || '').trim();
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // keep plain upstream error text as the message
    }
  }

  return {
    error: {
      type: errorType(status),
      message: value || fallbackMessage,
    },
  };
}

async function errorBody(error, status) {
  const data = error.response?.data;
  if (isReadableStream(data)) {
    const text = await readStreamText(data).catch(() => '');
    return errorBodyFromText(text, status, error.message);
  }

  if (Buffer.isBuffer(data)) return errorBodyFromText(data.toString('utf8'), status, error.message);
  if (typeof data === 'string') return errorBodyFromText(data, status, error.message);
  if (data && typeof data === 'object') return data;

  return {
    error: {
      type: errorType(status),
      message: error.message,
    },
  };
}

async function sendError(res, error) {
  const status = error.response?.status || error.statusCode || 500;
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  res.status(status).json(await errorBody(error, status));
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
    await sendError(res, error);
  }
}

gatewayRouter.post('/v1/messages', handleAnthropicMessages);
gatewayRouter.post('/anthropic/v1/messages', handleAnthropicMessages);

async function handleAnthropicModels(req, res) {
  try {
    const data = await executeModelsRequest({ req });
    res.json(data);
  } catch (error) {
    await sendError(res, error);
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
