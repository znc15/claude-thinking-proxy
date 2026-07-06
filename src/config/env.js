import 'dotenv/config';

export const env = {
  port: Number.parseInt(process.env.PORT || '8848', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  defaultUpstreamUrl: process.env.DEFAULT_UPSTREAM_URL || 'https://api.anthropic.com',
  defaultApiKey: process.env.DEFAULT_API_KEY || '',
  defaultThinkingEnabled: process.env.DEFAULT_THINKING_ENABLED !== 'false',
  defaultThinkingBudget: Number.parseInt(process.env.DEFAULT_THINKING_BUDGET || '5000', 10),
};
