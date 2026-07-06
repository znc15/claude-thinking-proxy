import 'dotenv/config';

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'disabled'].includes(String(value).trim().toLowerCase());
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonUpstreams(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item, index) => ({
        name: item.name || `upstream-${index + 1}`,
        type: item.type || 'anthropic',
        baseUrl: item.baseUrl || item.url || item.upstreamUrl,
        apiKey: item.apiKey || item.key || '',
        model: item.model || item.modelOverride || '',
        enabled: item.enabled !== false,
      }))
      .filter((item) => item.enabled && item.baseUrl);
  } catch {
    return [];
  }
}

function parseListUpstreams() {
  const urls = splitList(process.env.UPSTREAM_URLS);
  if (urls.length === 0) return [];

  const keys = splitList(process.env.UPSTREAM_API_KEYS);
  const types = splitList(process.env.UPSTREAM_TYPES);
  const models = splitList(process.env.UPSTREAM_MODELS);
  return urls.map((baseUrl, index) => ({
    name: `upstream-${index + 1}`,
    type: types[index] || 'anthropic',
    baseUrl,
    apiKey: keys[index] || '',
    model: models[index] || '',
    enabled: true,
  }));
}

function parseDefaultUpstream() {
  return [{
    name: 'default',
    type: 'anthropic',
    baseUrl: process.env.DEFAULT_UPSTREAM_URL || 'https://api.anthropic.com',
    apiKey: process.env.DEFAULT_API_KEY || '',
    model: '',
    enabled: true,
  }];
}

function parseUpstreams() {
  const configured = parseJsonUpstreams(process.env.UPSTREAMS_JSON).concat(parseListUpstreams());
  const upstreams = configured.length > 0 ? configured : parseDefaultUpstream();
  return upstreams
    .map((item) => ({
      ...item,
      type: String(item.type || 'anthropic').toLowerCase(),
    }))
    .filter((item, index, items) => (
      ['anthropic', 'openai'].includes(item.type) &&
      items.findIndex((candidate) => candidate.type === item.type && candidate.baseUrl === item.baseUrl) === index
    ));
}

export const env = {
  get port() {
    return Number.parseInt(process.env.PORT || '8848', 10);
  },
  get nodeEnv() {
    return process.env.NODE_ENV || 'development';
  },
  get defaultUpstreamUrl() {
    return process.env.DEFAULT_UPSTREAM_URL || 'https://api.anthropic.com';
  },
  get defaultApiKey() {
    return process.env.DEFAULT_API_KEY || '';
  },
  get defaultThinkingEnabled() {
    return parseBoolean(process.env.DEFAULT_THINKING_ENABLED, true);
  },
  get defaultThinkingBudget() {
    return Number.parseInt(process.env.DEFAULT_THINKING_BUDGET || '5000', 10);
  },
  get upstreams() {
    return parseUpstreams();
  },
};
