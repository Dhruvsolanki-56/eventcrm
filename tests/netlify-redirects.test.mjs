import { describe, expect, test } from 'vitest';
import { renderNetlifyRedirects } from '../scripts/netlify-redirects.mjs';

describe('Netlify backend proxy rules', () => {
  test('keeps preview API and unsubscribe routes explicitly unavailable until a backend is configured', () => {
    expect(renderNetlifyRedirects()).toBe([
      '/api/* /backend-unavailable.json 503',
      '/unsubscribe/* /backend-unavailable.json 503',
      '/* /index.html 200',
      '',
    ].join('\n'));
  });

  test('proxies API and unsubscribe routes to an HTTPS backend before the SPA fallback', () => {
    expect(renderNetlifyRedirects('https://gather-api.example.net/')).toBe([
      '/api/* https://gather-api.example.net/api/:splat 200',
      '/unsubscribe/* https://gather-api.example.net/unsubscribe/:splat 200',
      '/* /index.html 200',
      '',
    ].join('\n'));
  });

  test.each([
    'http://gather-api.example.net',
    'https://user:password@gather-api.example.net',
    'https://gather-api.example.net/api',
  ])('rejects unsafe or malformed backend origins: %s', (origin) => {
    expect(() => renderNetlifyRedirects(origin)).toThrow();
  });
});
