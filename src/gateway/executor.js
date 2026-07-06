import axios from 'axios';

import { env } from '../config/env.js';
import { anthropicEndpoint } from '../utils/upstream-url.js';
import { enhanceAnthropicRequest, parseThinkingFromAnthropicResponse } from './thinking.js';

const DEFAULT_TIMEOUT_MS = 120_000;

function bearerToken(header = '') {
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function upstreamApiKey(headers = {}) {
  return headers['x-api-key'] || bearerToken(headers.authorization) || env.defaultApiKey;
}

function requestHeaders(req) {
  const apiKey = upstreamApiKey(req.headers);
  if (!apiKey) {
    const error = new Error('Missing Anthropic API key. Set DEFAULT_API_KEY or pass x-api-key/Authorization.');
    error.statusCode = 401;
    throw error;
  }

  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
}

function enhancedRequest(req) {
  if (!req.body?.model) {
    const error = new Error('model is required');
    error.statusCode = 400;
    throw error;
  }

  return enhanceAnthropicRequest(
    req.body,
    {
      defaultThinkingEnabled: env.defaultThinkingEnabled,
      defaultThinkingBudget: env.defaultThinkingBudget,
    },
    req.headers,
  );
}

export async function executeJsonRequest({ req }) {
  const enhanced = enhancedRequest(req);
  const response = await axios.post(
    anthropicEndpoint(env.defaultUpstreamUrl, '/messages'),
    enhanced.body,
    {
      headers: requestHeaders(req),
      timeout: DEFAULT_TIMEOUT_MS,
    },
  );

  return enhanced.enabled
    ? parseThinkingFromAnthropicResponse(response.data, enhanced.body)
    : response.data;
}

export async function executeStreamRequest({ req, res }) {
  const enhanced = enhancedRequest(req);
  const response = await axios.post(
    anthropicEndpoint(env.defaultUpstreamUrl, '/messages'),
    { ...enhanced.body, stream: true },
    {
      headers: requestHeaders(req),
      responseType: 'stream',
      timeout: DEFAULT_TIMEOUT_MS,
    },
  );

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  response.data.pipe(res);
  response.data.on('error', () => {
    if (!res.writableEnded) res.end();
  });
}
