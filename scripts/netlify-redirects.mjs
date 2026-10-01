export function renderNetlifyRedirects(configuredOrigin = '') {
  if (!configuredOrigin.trim()) return [
    '/api/* /backend-unavailable.json 503',
    '/unsubscribe/* /backend-unavailable.json 503',
    '/* /index.html 200',
    '',
  ].join('\n');

  let apiOrigin;
  try {
    apiOrigin = new URL(configuredOrigin.trim());
  } catch {
    throw new Error('GATHER_API_ORIGIN must be a valid HTTPS origin.');
  }
  if (apiOrigin.protocol !== 'https:' || apiOrigin.username || apiOrigin.password || apiOrigin.search || apiOrigin.hash || !['', '/'].includes(apiOrigin.pathname)) {
    throw new Error('GATHER_API_ORIGIN must be an HTTPS origin only, without credentials, path, query, or fragment.');
  }
  return [
    `/api/* ${apiOrigin.origin}/api/:splat 200`,
    `/unsubscribe/* ${apiOrigin.origin}/unsubscribe/:splat 200`,
    '/* /index.html 200',
    '',
  ].join('\n');
}
