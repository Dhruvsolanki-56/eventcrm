import { describe, expect, it } from 'vitest';
import { fetchPublicPageText, isPublicAddress, pageToText, publicWebAddress } from './safe-web.js';

describe('safe website reading', () => {
  it('only treats public internet addresses as safe', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(address)).toBe(true);
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) expect(isPublicAddress(address)).toBe(false);
  });

  it('turns typed websites into web addresses and refuses unsafe ones', () => {
    expect(publicWebAddress('acmepackaging.example').toString()).toBe('https://acmepackaging.example/');
    expect(publicWebAddress('http://www.acme.example/about').hostname).toBe('www.acme.example');
    for (const bad of ['', 'localhost', 'http://localhost/admin', 'http://127.0.0.1', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'ftp://acme.example', 'file:///etc/passwd', 'https://user:pass@acme.example', 'https://acme.example:8080', 'http://intranet', 'https://printer.local', 'javascript:alert(1)']) {
      expect(() => publicWebAddress(bad), bad).toThrow();
    }
  });

  it('never connects to a private address', async () => {
    await expect(fetchPublicPageText('http://127.0.0.1:80/')).rejects.toThrow('cannot be read');
    await expect(fetchPublicPageText('http://10.0.0.5')).rejects.toThrow('cannot be read');
    await expect(fetchPublicPageText('localhost')).rejects.toThrow();
  });

  it('keeps the readable words of a page and drops scripts, styles and tags', () => {
    const text = pageToText('<html><head><title>Acme &amp; Co</title><meta name="description" content="Retail packaging for beauty brands"><style>.a{color:red}</style><script>alert("x")</script></head><body><h1>Hello</h1><p>We make boxes.</p><!-- hidden --></body></html>');
    expect(text).toContain('Acme & Co');
    expect(text).toContain('Retail packaging for beauty brands');
    expect(text).toContain('We make boxes.');
    expect(text).not.toMatch(/alert|color:red|hidden|<p>/);
  });
});
