const THINKING_PROMPTS = {
  zh: {
    systemPrompt: `你必须严格遵循以下两步格式回答：

第一步：用 <thinking> 标签包裹你的详细思考过程。
第二步：用 <answer> 标签包裹最终答案。

重要：必须同时包含 <thinking> 和 <answer> 两个部分。`,
    reminder: '\n\n[记住：必须先用 <thinking> 标签展示思考过程，然后用 <answer> 标签给出答案]',
  },
  en: {
    systemPrompt: `You MUST strictly follow this two-step format:

Step 1: Wrap your reasoning in <thinking> tags.
Step 2: Wrap the final answer in <answer> tags.

CRITICAL: Include both <thinking> and <answer> sections.`,
    reminder: '\n\n[Remember: first use <thinking> tags, then use <answer> tags.]',
  },
};

function headerValue(headers = {}, name) {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function thinkingModeHeader(headers = {}) {
  return String(headerValue(headers, 'x-gateway-thinking') || headerValue(headers, 'x-thinking-mode') || '')
    .trim()
    .toLowerCase();
}

function thinkingIsDisabled(body, headers) {
  const headerMode = thinkingModeHeader(headers);
  const gatewayThinking = body?.gateway_thinking || body?.gatewayThinking;
  return (
    ['0', 'false', 'off', 'disabled', 'none'].includes(headerMode) ||
    gatewayThinking?.enabled === false ||
    gatewayThinking?.type === 'disabled' ||
    body?.thinking?.enabled === false ||
    body?.thinking?.type === 'disabled'
  );
}

function hasNativeThinking(body) {
  const thinking = body?.thinking;
  return Boolean(
    thinking &&
      typeof thinking === 'object' &&
      (thinking.type === 'enabled' || thinking.budget_tokens || thinking.budgetTokens)
  );
}

function stripGatewayThinkingControls(body) {
  const next = { ...body };
  delete next.gateway_thinking;
  delete next.gatewayThinking;
  return next;
}

function parseBudget(body, settings = {}) {
  return Number.parseInt(
    body?.thinking?.budget_tokens ||
      body?.thinking?.budgetTokens ||
      body?.gateway_thinking?.budget_tokens ||
      body?.gatewayThinking?.budgetTokens ||
      settings.defaultThinkingBudget ||
      5000,
    10,
  );
}

function lastUserText(messages) {
  const message = [...messages].reverse().find((item) => item.role === 'user');
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.find((part) => part.type === 'text')?.text || '';
  }
  return '';
}

function appendReminder(messages, reminder) {
  const next = JSON.parse(JSON.stringify(messages));
  let index = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].role === 'user') {
      index = i;
      break;
    }
  }
  if (index === -1) return next;

  const content = next[index].content;
  if (typeof content === 'string') {
    next[index].content = `${content}${reminder}`;
    return next;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find((part) => part.type === 'text');
    if (textBlock) textBlock.text = `${textBlock.text || ''}${reminder}`;
    else content.push({ type: 'text', text: reminder.trim() });
  }

  return next;
}

function appendSystemPrompt(system, prompt) {
  if (!system) return prompt;
  if (typeof system === 'string') return `${system}\n\n${prompt}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: prompt }];
  return prompt;
}

export function detectLanguage(text) {
  const chineseChars = String(text || '').match(/[一-龥]/g);
  return chineseChars && chineseChars.length > 10 ? 'zh' : 'en';
}

export function resolveThinkingMode(body, settings = {}, headers = {}) {
  if (thinkingIsDisabled(body, headers)) return 'off';
  if (hasNativeThinking(body)) return 'native';
  if (settings.defaultThinkingEnabled === false) return 'off';
  return 'proxy';
}

export function enhanceAnthropicRequest(body, settings = {}, headers = {}) {
  const mode = resolveThinkingMode(body, settings, headers);
  const cleanBody = stripGatewayThinkingControls(body || {});

  if (mode === 'off') {
    if (cleanBody.thinking?.enabled === false || cleanBody.thinking?.type === 'disabled') delete cleanBody.thinking;
    return { body: cleanBody, enabled: false, mode };
  }

  if (mode === 'native') return { body: cleanBody, enabled: true, mode };

  const messages = Array.isArray(cleanBody.messages) ? cleanBody.messages : [];
  if (messages.length === 0) return { body: cleanBody, enabled: false, mode: 'off' };

  const language = detectLanguage(lastUserText(messages));
  const prompt = THINKING_PROMPTS[language];
  const budget = parseBudget(cleanBody, settings);
  const maxTokens = Math.max(cleanBody.max_tokens || 4096, budget + 2000);

  return {
    enabled: true,
    mode,
    body: {
      ...cleanBody,
      system: appendSystemPrompt(cleanBody.system, prompt.systemPrompt),
      messages: appendReminder(messages, prompt.reminder),
      max_tokens: Math.min(maxTokens, 16000),
      temperature: cleanBody.temperature ?? 1.0,
    },
  };
}

export function stripThinkingTags(text) {
  return String(text || '').replace(/<\/?(?:thinking|answer)>/g, '').trim();
}

function textFromLastUser(originalRequest) {
  return lastUserText(Array.isArray(originalRequest?.messages) ? originalRequest.messages : [])
    .replace(/\[记住：.*?\]/gs, '')
    .replace(/\[Remember:.*?\]/gs, '')
    .trim();
}

function parseTextBlock(text, originalRequest) {
  const thinkingMatch = String(text).match(/<thinking>([\s\S]*?)<\/thinking>/);
  const answerMatch = String(text).match(/<answer>([\s\S]*?)<\/answer>/);
  const blocks = [];

  if (thinkingMatch?.[1]?.trim()) {
    blocks.push({ type: 'thinking', thinking: stripThinkingTags(thinkingMatch[1]) });
  }

  if (!thinkingMatch && answerMatch) {
    const question = textFromLastUser(originalRequest) || 'the request';
    blocks.push({
      type: 'thinking',
      thinking: detectLanguage(question) === 'zh' ? `分析请求："${question}"` : `Analyzing request: "${question}"`,
    });
  }

  if (answerMatch?.[1]?.trim()) {
    blocks.push({ type: 'text', text: stripThinkingTags(answerMatch[1]) });
  } else if (thinkingMatch) {
    const afterThinking = text.slice(thinkingMatch.index + thinkingMatch[0].length);
    const answer = stripThinkingTags(afterThinking);
    if (answer) blocks.push({ type: 'text', text: answer });
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', text: stripThinkingTags(text) || text }];
}

export function parseThinkingFromAnthropicResponse(responseData, originalRequest) {
  if (!Array.isArray(responseData?.content)) return responseData;

  const content = responseData.content.flatMap((block) => {
    if (block.type !== 'text') return [block];
    return parseTextBlock(block.text || '', originalRequest);
  });

  return { ...responseData, content };
}
