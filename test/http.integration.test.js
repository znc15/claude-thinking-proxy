import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function listen(server) {
  return new Promise((resolve) => {
    const instance = server.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

function resetUpstreamEnv() {
  delete process.env.UPSTREAMS_JSON;
  delete process.env.UPSTREAM_URLS;
  delete process.env.UPSTREAM_API_KEYS;
  delete process.env.UPSTREAM_TYPES;
  delete process.env.UPSTREAM_MODELS;
  process.env.DEFAULT_API_KEY = '';
  process.env.DEFAULT_THINKING_ENABLED = 'true';
  process.env.DEFAULT_THINKING_BUDGET = '1000';
}

function createMockAnthropic(options = {}) {
  const seen = { messages: [], models: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      if (options.modelsStatus) {
        res.statusCode = options.modelsStatus;
        res.end('models failed');
        return;
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      seen.models.push({
        query: Object.fromEntries(url.searchParams),
        apiKey: req.headers['x-api-key'],
        anthropicVersion: req.headers['anthropic-version'],
      });

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'claude-test', type: 'model', display_name: 'Claude Test' }],
        has_more: false,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages') {
      if (options.messagesStatus) {
        res.statusCode = options.messagesStatus;
        res.end('messages failed');
        return;
      }

      const body = await readJson(req);
      seen.messages.push({
        body,
        apiKey: req.headers['x-api-key'],
        anthropicVersion: req.headers['anthropic-version'],
      });

      if (body.stream === true) {
        const events = [
          { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [] } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<thinking>mock reasoning</think' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing><ans' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wer>pong</answer>' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
          { type: 'message_stop' },
        ];

        res.setHeader('content-type', 'text/event-stream');
        for (const event of events) {
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: options.text || '<thinking>mock reasoning</thinking><answer>pong</answer>' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  return { server, seen };
}

function createMockOpenAI() {
  const seen = { chat: [], models: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      seen.models.push({ authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readJson(req);
      seen.chat.push({ body, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chat_mock',
        object: 'chat.completion',
        model: body.model,
        choices: [{ message: { role: 'assistant', content: '<answer>openai pong</answer>' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  return { server, seen };
}

async function createTestApp(upstreams) {
  resetUpstreamEnv();
  if (upstreams.length === 1 && upstreams[0].type === 'anthropic') {
    process.env.DEFAULT_UPSTREAM_URL = upstreams[0].baseUrl;
    process.env.DEFAULT_API_KEY = upstreams[0].apiKey || '';
  } else {
    process.env.UPSTREAMS_JSON = JSON.stringify(upstreams);
  }

  const { createApp } = await import(`../src/server.js?test=${Date.now()}-${Math.random()}`);
  const appServer = await listen(createApp());
  return {
    server: appServer,
    baseUrl: `http://127.0.0.1:${appServer.address().port}`,
  };
}

test('anthropic messages proxy injects and parses thinking blocks', async () => {
  const mock = createMockAnthropic();
  await listen(mock.server);
  const app = await createTestApp([{ type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.server.address().port}` }]);

  try {
    const health = await fetch(`${app.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'client-secret',
      },
      body: JSON.stringify({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 64,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.content, [
      { type: 'thinking', thinking: 'mock reasoning' },
      { type: 'text', text: 'pong' },
    ]);
    assert.equal(mock.seen.messages[0].apiKey, 'client-secret');
    assert.equal(mock.seen.messages[0].anthropicVersion, '2023-06-01');
    assert.match(mock.seen.messages[0].body.system, /thinking/);
    assert.match(mock.seen.messages[0].body.messages[0].content, /<thinking>/);
  } finally {
    await close(app.server);
    await close(mock.server);
  }
});

test('disabled thinking responses do not leak answer tags', async () => {
  const mock = createMockAnthropic();
  await listen(mock.server);
  const app = await createTestApp([{ type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.server.address().port}` }]);

  try {
    const response = await fetch(`${app.baseUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer bearer-secret',
        'x-gateway-thinking': 'off',
      },
      body: JSON.stringify({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'plain ping' }],
        max_tokens: 64,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.content[0].text, 'pong');
    assert.equal(mock.seen.messages[0].apiKey, 'bearer-secret');
    assert.equal(mock.seen.messages[0].body.system, undefined);
  } finally {
    await close(app.server);
    await close(mock.server);
  }
});

test('streaming responses do not leak answer tags', async () => {
  const mock = createMockAnthropic();
  await listen(mock.server);
  const app = await createTestApp([{ type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.server.address().port}` }]);

  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'client-secret',
      },
      body: JSON.stringify({
        model: 'claude-test',
        stream: true,
        messages: [{ role: 'user', content: 'stream ping' }],
        max_tokens: 64,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /mock reasoning/);
    assert.match(body, /pong/);
    assert.doesNotMatch(body, /<\/?(?:thinking|answer)>/);
    assert.equal(mock.seen.messages[0].body.stream, true);
  } finally {
    await close(app.server);
    await close(mock.server);
  }
});

test('streaming upstream errors return stable json errors', async () => {
  const mock = createMockAnthropic({ messagesStatus: 500 });
  await listen(mock.server);
  const app = await createTestApp([{ type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.server.address().port}` }]);

  try {
    const response = await fetch(`${app.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'client-secret',
      },
      body: JSON.stringify({
        model: 'claude-test',
        stream: true,
        messages: [{ role: 'user', content: 'stream failure' }],
        max_tokens: 64,
      }),
    });

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, {
      error: {
        type: 'proxy_error',
        message: 'messages failed',
      },
    });
  } finally {
    await close(app.server);
    await close(mock.server);
  }
});

test('models proxy aggregates anthropic and openai-compatible channels', async () => {
  const anthropic = createMockAnthropic();
  const openai = createMockOpenAI();
  await listen(anthropic.server);
  await listen(openai.server);
  const app = await createTestApp([
    { name: 'anthropic', type: 'anthropic', baseUrl: `http://127.0.0.1:${anthropic.server.address().port}`, apiKey: 'anthropic-secret' },
    { name: 'openai', type: 'openai', baseUrl: `http://127.0.0.1:${openai.server.address().port}`, apiKey: 'openai-secret' },
  ]);

  try {
    const response = await fetch(`${app.baseUrl}/v1/models?limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.map((model) => model.id).sort(), ['claude-test', 'gpt-test']);
    assert.equal(anthropic.seen.models[0].apiKey, 'anthropic-secret');
    assert.deepEqual(anthropic.seen.models[0].query, { limit: '1' });
    assert.equal(openai.seen.models[0].authorization, 'Bearer openai-secret');
  } finally {
    await close(app.server);
    await close(anthropic.server);
    await close(openai.server);
  }
});

test('messages fallback converts to second openai-compatible channel', async () => {
  const failingAnthropic = createMockAnthropic({ messagesStatus: 500 });
  const openai = createMockOpenAI();
  await listen(failingAnthropic.server);
  await listen(openai.server);
  const app = await createTestApp([
    { name: 'primary', type: 'anthropic', baseUrl: `http://127.0.0.1:${failingAnthropic.server.address().port}`, apiKey: 'bad-secret' },
    { name: 'secondary', type: 'openai', baseUrl: `http://127.0.0.1:${openai.server.address().port}`, apiKey: 'openai-secret', model: 'gpt-test' },
  ]);

  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-thinking': 'off',
      },
      body: JSON.stringify({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'fallback ping' }],
        max_tokens: 64,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.content[0].text, 'openai pong');
    assert.equal(openai.seen.chat[0].authorization, 'Bearer openai-secret');
    assert.equal(openai.seen.chat[0].body.model, 'gpt-test');
    assert.deepEqual(openai.seen.chat[0].body.messages, [{ role: 'user', content: 'fallback ping' }]);
  } finally {
    await close(app.server);
    await close(failingAnthropic.server);
    await close(openai.server);
  }
});
