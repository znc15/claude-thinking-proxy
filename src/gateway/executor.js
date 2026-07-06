import { Transform } from 'node:stream';

import axios from 'axios';

import { env } from '../config/env.js';
import { anthropicEndpoint, openaiEndpoint } from '../utils/upstream-url.js';
import {
  cleanAnthropicResponse,
  enhanceAnthropicRequest,
  parseThinkingFromAnthropicResponse,
} from './thinking.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const RESPONSE_TAGS = ['<thinking>', '</thinking>', '<answer>', '</answer>'];

function bearerToken(header = '') {
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requestApiKey(headers = {}) {
  return headers['x-api-key'] || bearerToken(headers.authorization) || '';
}

function channelApiKey(channel, req) {
  return channel.apiKey || requestApiKey(req.headers) || env.defaultApiKey;
}

function requireApiKey(channel, req) {
  const apiKey = channelApiKey(channel, req);
  if (!apiKey) {
    const error = new Error(`Missing API key for upstream ${channel.name}. Set channel apiKey, DEFAULT_API_KEY, or pass x-api-key/Authorization.`);
    error.statusCode = 401;
    throw error;
  }
  return apiKey;
}

function anthropicHeaders(channel, req) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': requireApiKey(channel, req),
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
}

function openaiHeaders(channel, req) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${requireApiKey(channel, req)}`,
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

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n');
}

function systemToText(system) {
  if (typeof system === 'string') return system;
  return textFromContent(system);
}

function anthropicToOpenAI(body, model) {
  const messages = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const message of body.messages || []) {
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: textFromContent(message.content),
    });
  }

  return {
    model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stream: false,
  };
}

function openAIToAnthropic(responseData, requestedModel) {
  const choice = responseData?.choices?.[0] || {};
  return {
    id: responseData?.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: [{ type: 'text', text: choice.message?.content || choice.text || '' }],
    stop_reason: choice.finish_reason || 'end_turn',
    usage: responseData?.usage ? {
      input_tokens: responseData.usage.prompt_tokens,
      output_tokens: responseData.usage.completion_tokens,
    } : undefined,
  };
}

function normalizeOpenAIModels(responseData) {
  const data = Array.isArray(responseData?.data) ? responseData.data : [];
  return data.map((item) => ({
    id: item.id,
    type: 'model',
    display_name: item.id,
  })).filter((item) => item.id);
}

function normalizeAnthropicModels(responseData) {
  const data = Array.isArray(responseData?.data) ? responseData.data : [];
  return data.map((item) => ({
    id: item.id,
    type: item.type || 'model',
    display_name: item.display_name || item.id,
  })).filter((item) => item.id);
}

function responseForClient(responseData, originalRequest, thinkingEnabled) {
  return thinkingEnabled
    ? parseThinkingFromAnthropicResponse(responseData, originalRequest)
    : cleanAnthropicResponse(responseData);
}

function createResponseTagFilter() {
  let pending = '';

  function isTagPrefix(value) {
    const lower = value.toLowerCase();
    return RESPONSE_TAGS.some((tag) => tag.startsWith(lower));
  }

  function isCompleteTag(value) {
    return RESPONSE_TAGS.includes(value.toLowerCase());
  }

  return {
    clean(text = '') {
      let output = '';

      for (const char of String(text)) {
        if (pending) {
          pending += char;
          if (isCompleteTag(pending)) {
            pending = '';
          } else if (!isTagPrefix(pending)) {
            output += pending;
            pending = '';
          }
          continue;
        }

        if (char === '<') {
          pending = char;
        } else {
          output += char;
        }
      }

      return output;
    },
  };
}

function transformSseFrame(frame, tagFilter) {
  const lines = frame.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return frame;

  const dataText = dataLines.join('\n');
  if (!dataText || dataText === '[DONE]') return frame;

  let data;
  try {
    data = JSON.parse(dataText);
  } catch {
    return frame;
  }

  if (data?.type === 'content_block_start' && data.content_block?.type === 'text') {
    data.content_block.text = tagFilter.clean(data.content_block.text || '');
  }

  if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
    data.delta.text = tagFilter.clean(data.delta.text || '');
  }

  let dataWritten = false;
  return lines
    .map((line) => {
      if (!line.startsWith('data:')) return line;
      if (dataWritten) return null;
      dataWritten = true;
      return `data: ${JSON.stringify(data)}`;
    })
    .filter((line) => line !== null)
    .join('\n');
}

function createSseTagCleaner() {
  let buffer = '';
  const tagFilter = createResponseTagFilter();

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString('utf8');
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';

      const output = frames
        .map((frame) => transformSseFrame(frame, tagFilter))
        .join('\n\n');

      callback(null, output ? `${output}\n\n` : '');
    },
    flush(callback) {
      const output = buffer ? transformSseFrame(buffer, tagFilter) : '';
      callback(null, output ? `${output}\n\n` : '');
    },
  });
}

function writeSseError(res, error) {
  if (res.writableEnded || res.destroyed) return;

  const payload = {
    type: 'error',
    error: {
      type: 'proxy_error',
      message: error?.message || 'Upstream stream failed',
    },
  };

  res.write(`event: error\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

function shouldTryNext(error) {
  const status = error.response?.status || error.statusCode;
  return !status || status === 401 || status === 403 || status === 404 || status === 429 || status >= 500;
}

function upstreams() {
  const channels = env.upstreams;
  if (channels.length > 0) return channels;
  return [{ name: 'default', type: 'anthropic', baseUrl: env.defaultUpstreamUrl, apiKey: env.defaultApiKey }];
}

async function tryChannels(handler) {
  let lastError;
  for (const channel of upstreams()) {
    try {
      return await handler(channel);
    } catch (error) {
      lastError = error;
      if (!shouldTryNext(error)) break;
    }
  }
  throw lastError || new Error('No upstream channel is configured');
}

export async function executeJsonRequest({ req }) {
  const enhanced = enhancedRequest(req);
  const requestedModel = req.body.model;

  return tryChannels(async (channel) => {
    const model = channel.model || requestedModel;
    let responseData;

    if (channel.type === 'openai') {
      const response = await axios.post(
        openaiEndpoint(channel.baseUrl, '/chat/completions'),
        anthropicToOpenAI(enhanced.body, model),
        {
          headers: openaiHeaders(channel, req),
          timeout: DEFAULT_TIMEOUT_MS,
        },
      );
      responseData = openAIToAnthropic(response.data, requestedModel);
    } else {
      const response = await axios.post(
        anthropicEndpoint(channel.baseUrl, '/messages'),
        { ...enhanced.body, model },
        {
          headers: anthropicHeaders(channel, req),
          timeout: DEFAULT_TIMEOUT_MS,
        },
      );
      responseData = response.data;
    }

    return responseForClient(responseData, enhanced.body, enhanced.enabled);
  });
}

export async function executeModelsRequest({ req }) {
  const results = [];
  let lastError;

  for (const channel of upstreams()) {
    try {
      if (channel.type === 'openai') {
        const response = await axios.get(openaiEndpoint(channel.baseUrl, '/models'), {
          headers: openaiHeaders(channel, req),
          params: req.query,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        results.push(...normalizeOpenAIModels(response.data));
      } else {
        const response = await axios.get(anthropicEndpoint(channel.baseUrl, '/models'), {
          headers: anthropicHeaders(channel, req),
          params: req.query,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        results.push(...normalizeAnthropicModels(response.data));
      }
    } catch (error) {
      lastError = error;
      if (!shouldTryNext(error)) break;
    }
  }

  const unique = results.filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index);
  if (unique.length > 0) {
    return { object: 'list', data: unique, has_more: false };
  }

  throw lastError || new Error('No upstream channel returned models');
}

export async function executeStreamRequest({ req, res }) {
  const enhanced = enhancedRequest(req);

  const response = await tryChannels(async (channel) => {
    if (channel.type !== 'anthropic') {
      const error = new Error(`Streaming is not supported for ${channel.type} upstream ${channel.name}`);
      error.statusCode = 501;
      throw error;
    }

    return axios.post(
      anthropicEndpoint(channel.baseUrl, '/messages'),
      { ...enhanced.body, model: channel.model || req.body.model, stream: true },
      {
        headers: anthropicHeaders(channel, req),
        responseType: 'stream',
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const cleaner = createSseTagCleaner();
  const finishWithError = (error) => writeSseError(res, error);

  response.data.on('error', finishWithError);
  cleaner.on('error', finishWithError);
  res.on('close', () => {
    response.data.destroy();
    cleaner.destroy();
  });

  response.data.pipe(cleaner).pipe(res);
}
