import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 400 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;

/** True only for an address on the public internet. Everything private, local or reserved is refused. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && ((b === 0 && c === 0) || b === 168 || (b === 0 && c === 2))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')) return false;
    if (lower.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

/** Turns what a person typed into a plain http(s) address, or throws a message that is safe to show. */
export function publicWebAddress(value: string): URL {
  const text = value.trim();
  if (!text) throw new Error('No website is saved for this company.');
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw new Error('This website address is not valid.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only normal web addresses can be read.');
  if (url.username || url.password) throw new Error('This website address is not valid.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Only normal web addresses can be read.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes('.') && !isIP(host)) throw new Error('This website address is not valid.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && !isPublicAddress(host))) {
    throw new Error('This website address cannot be read.');
  }
  return url;
}

// The check runs when the connection is made, so a name that later points somewhere private is still refused.
const guardedLookup: typeof dnsLookup = ((hostname: string, options: unknown, callback: unknown) => {
  const done = (typeof options === 'function' ? options : callback) as (error: Error | null, address?: unknown, family?: number) => void;
  const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) return done(error);
    const list = addresses as Array<{ address: string; family: number }>;
    if (!list.length || list.some((item) => !isPublicAddress(item.address))) return done(new Error('This website address cannot be read.'));
    return wantsAll ? done(null, list) : done(null, list[0].address, list[0].family);
  });
}) as typeof dnsLookup;

type Page = { status: number; location: string | null; contentType: string; body: string };

function getOnce(url: URL): Promise<Page> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: 'GET', lookup: guardedLookup, headers: { 'User-Agent': 'GatherCRM-CompanyInfo/1.0', Accept: 'text/html,text/plain;q=0.9', 'Accept-Language': 'en' }, timeout: TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : null;
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location, contentType, body: '' }); }
      if (!/^text\/(html|plain)|application\/xhtml/.test(contentType)) { res.resume(); return resolve({ status, location, contentType, body: '' }); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(); return resolve({ status, location, contentType, body: Buffer.concat(chunks).toString('utf8') }); }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const decodeEntities = (text: string) => text
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d{2,5});/g, (_all, code: string) => { const n = Number(code); return n > 31 && n < 65535 ? String.fromCharCode(n) : ' '; });

/** The readable words of a page: title, description and visible text. Scripts, styles and tags are dropped. */
export function pageToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const description = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i.exec(html)?.[1] ?? '';
  const visible = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities([title, description, visible].join('\n')).replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Reads one public web page as text. Refuses private addresses, odd ports and oversized or non-text pages. */
export async function fetchPublicPageText(address: string): Promise<{ text: string; finalUrl: string }> {
  let url = publicWebAddress(address);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let page: Page;
    try { page = await getOnce(url); }
    catch (error) {
      if (error instanceof Error && error.message === 'This website address cannot be read.') throw error;
      throw new Error('The website could not be reached right now.');
    }
    if (page.status >= 300 && page.status < 400 && page.location) {
      try { url = publicWebAddress(new URL(page.location, url).toString()); }
      catch { throw new Error('This website address cannot be read.'); }
      continue;
    }
    if (page.status < 200 || page.status >= 300) throw new Error('The website did not open normally.');
    const text = pageToText(page.body);
    if (text.length < 40) throw new Error('The website has too little readable text.');
    return { text: text.slice(0, 6000), finalUrl: url.toString() };
  }
  throw new Error('The website redirected too many times.');
}
