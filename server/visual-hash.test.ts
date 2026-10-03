import { afterEach, expect, test, vi } from 'vitest';
import sharp from 'sharp';
import { imageDifferenceHash, imageHashDistance } from './visual-hash.js';
import { leadMailTransportReady, sendResendEmail } from './resend-email.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('re-encoding a card leaves its visual identity unchanged', async () => {
  const pixels = Buffer.alloc(90 * 80 * 3);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 90; x++) {
    const offset = (y * 90 + x) * 3;
    pixels.fill((Math.floor(x / 10) * 27 + Math.floor(y / 10) * 11) % 255, offset, offset + 3);
  }
  const image = sharp(pixels, { raw: { width: 90, height: 80, channels: 3 } });
  const png = await image.png().toBuffer();
  const jpeg = await sharp(png).jpeg({ quality: 95 }).toBuffer();
  expect(imageHashDistance(await imageDifferenceHash(png), await imageDifferenceHash(jpeg))).toBeLessThanOrEqual(3);
  expect(imageHashDistance('invalid', '0000000000000000')).toBe(64);
});

test('HTTPS mail is off without an API key and uses one idempotent provider request when configured', async () => {
  vi.stubEnv('EMAIL_TRANSPORT', 'resend');
  vi.stubEnv('RESEND_API_KEY', 'test-local-key');
  expect(leadMailTransportReady()).toBe(true);
  const mocked = vi.fn(async (_url: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ 'Idempotency-Key': 'draft-1', Authorization: 'Bearer test-local-key' });
    const payload = JSON.parse(String(options.body));
    expect(payload.to).toEqual(['person@example.test']);
    expect(payload.text).toContain('Unsubscribe');
    return { ok: true, json: async () => ({ id: 'provider-message-1' }) };
  });
  vi.stubGlobal('fetch', mocked);
  expect(await sendResendEmail({ id: 'draft-1', fromAddress: 'sender@example.test', fromName: 'Gather', to: 'person@example.test', subject: 'Hello', text: 'Unsubscribe', unsubscribeUrl: 'https://example.test/unsubscribe/test' })).toBe('provider-message-1');
  expect(mocked).toHaveBeenCalledTimes(1);
  vi.stubEnv('RESEND_API_KEY', '');
  expect(leadMailTransportReady()).toBe(false);
});
