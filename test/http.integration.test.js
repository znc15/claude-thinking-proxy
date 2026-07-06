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

function createMockAnthropic() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const body = await readJson(req);
      seen.push({
        body,
        apiKey: req.headers['x-api-key'],
        anthropicVersion: req.headers['anthropic-version'],
      });

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: '<thinking>mock reasoning</thinking><answer>pong</answer>' }],
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

test('anthropic messages proxy injects and parses thinking blocks', async () => {
  const mock = createMockAnthropic();
  await listen(mock.server);

  process.env.DEFAULT_UPSTREAM_URL = `http://127.0.0.1:${mock.server.address().port}`;
  process.env.DEFAULT_API_KEY = '';
  process.env.DEFAULT_THINKING_ENABLED = 'true';
  process.env.DEFAULT_THINKING_BUDGET = '1000';

  const { createApp } = await import(`../src/server.js?test=${Date.now()}`);
  const appServer = await listen(createApp());
  const baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const response = await fetch(`${baseUrl}/v1/messages`, {
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
    assert.equal(mock.seen[0].apiKey, 'client-secret');
    assert.equal(mock.seen[0].anthropicVersion, '2023-06-01');
    assert.match(mock.seen[0].body.system, /thinking/);
    assert.match(mock.seen[0].body.messages[0].content, /<thinking>/);

    const disabled = await fetch(`${baseUrl}/anthropic/v1/messages`, {
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

    assert.equal(disabled.status, 200);
    const disabledBody = await disabled.json();
    assert.equal(disabledBody.content[0].text, '<thinking>mock reasoning</thinking><answer>pong</answer>');
    assert.equal(mock.seen[1].apiKey, 'bearer-secret');
    assert.equal(mock.seen[1].body.system, undefined);
  } finally {
    await close(appServer);
    await close(mock.server);
  }
});
