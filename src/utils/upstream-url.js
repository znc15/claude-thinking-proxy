function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

export function anthropicEndpoint(baseUrl, endpoint) {
  const base = trimTrailingSlash(baseUrl);
  if (base.endsWith('/v1')) return `${base}${endpoint}`;
  return `${base}/v1${endpoint}`;
}
