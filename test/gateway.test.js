import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectLanguage,
  enhanceAnthropicRequest,
  parseThinkingFromAnthropicResponse,
  resolveThinkingMode,
} from '../src/gateway/thinking.js';

test('thinking enhancement injects prompt and reminder', () => {
  const body = {
    model: 'claude-test',
    messages: [{ role: 'user', content: 'Explain 2+2' }],
    max_tokens: 100,
  };

  const enhanced = enhanceAnthropicRequest(body, {
    defaultThinkingEnabled: true,
    defaultThinkingBudget: 1000,
  });

  assert.equal(enhanced.enabled, true);
  assert.equal(enhanced.mode, 'proxy');
  assert.match(enhanced.body.system, /thinking/);
  assert.match(enhanced.body.messages[0].content, /<thinking>/);
  assert.equal(enhanced.body.max_tokens, 3000);
  assert.equal(body.messages[0].content, 'Explain 2+2');
});

test('thinking can be disabled per request', () => {
  assert.equal(
    resolveThinkingMode(
      { thinking: { type: 'disabled' } },
      { defaultThinkingEnabled: true },
    ),
    'off',
  );
  assert.equal(
    resolveThinkingMode(
      {},
      { defaultThinkingEnabled: true },
      { 'x-gateway-thinking': 'off' },
    ),
    'off',
  );

  const enhanced = enhanceAnthropicRequest(
    {
      model: 'claude-test',
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'No thinking' }],
    },
    { defaultThinkingEnabled: true },
  );

  assert.equal(enhanced.enabled, false);
  assert.equal(enhanced.body.thinking, undefined);
  assert.equal(enhanced.body.system, undefined);
});

test('native anthropic thinking passes through', () => {
  const body = {
    model: 'claude-test',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'user', content: 'Use native thinking' }],
  };

  const enhanced = enhanceAnthropicRequest(body, { defaultThinkingEnabled: true });

  assert.equal(enhanced.enabled, true);
  assert.equal(enhanced.mode, 'native');
  assert.deepEqual(enhanced.body.thinking, body.thinking);
  assert.equal(enhanced.body.system, undefined);
});

test('parser extracts thinking and answer blocks', () => {
  const parsed = parseThinkingFromAnthropicResponse({
    content: [{ type: 'text', text: '<thinking>work</thinking><answer>four</answer>' }],
  });

  assert.deepEqual(parsed.content, [
    { type: 'thinking', thinking: 'work' },
    { type: 'text', text: 'four' },
  ]);
});

test('parser creates fallback thinking when only answer exists', () => {
  const parsed = parseThinkingFromAnthropicResponse({
    content: [{ type: 'text', text: '<answer>four</answer>' }],
  }, {
    messages: [{ role: 'user', content: 'Explain 2+2' }],
  });

  assert.equal(parsed.content[0].type, 'thinking');
  assert.match(parsed.content[0].thinking, /Explain 2\+2/);
  assert.deepEqual(parsed.content[1], { type: 'text', text: 'four' });
});

test('detectLanguage switches to Chinese for Chinese prompts', () => {
  assert.equal(detectLanguage('请详细解释这个问题的原因和解决方案'), 'zh');
  assert.equal(detectLanguage('Explain the result'), 'en');
});
