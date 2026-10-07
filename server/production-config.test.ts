import { describe, expect, it } from 'vitest';
import { checkProductionConfig } from './production-config.js';

const good = { NODE_ENV: 'production', DATABASE_URL: 'postgres://db/x', UPLOADS_PATH: '/var/data/uploads', PUBLIC_BASE_URL: 'https://crm.example.com', EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'x', SMTP_FROM_ADDRESS: 'team@example.com', TRUST_PROXY_HOPS: '1' };

describe('production configuration check', () => {
  it('stays silent outside production', () => {
    expect(checkProductionConfig({ NODE_ENV: 'development' })).toEqual({ errors: [], warnings: [] });
    expect(checkProductionConfig({ NODE_ENV: 'test', GATHER_DEMO_MODE: 'true' })).toEqual({ errors: [], warnings: [] });
  });
  it('accepts a complete production setup', () => {
    expect(checkProductionConfig(good)).toEqual({ errors: [], warnings: [] });
  });
  it('refuses data in temporary folders and a non-https public address', () => {
    const report = checkProductionConfig({ ...good, DATABASE_URL: undefined, DATABASE_PATH: '/tmp/gather.sqlite', UPLOADS_PATH: '/tmp/uploads', PUBLIC_BASE_URL: 'http://crm.example.com' });
    expect(report.errors).toHaveLength(3);
    expect(report.errors.join(' ')).toMatch(/database.*temporary/i);
    expect(report.errors.join(' ')).toMatch(/photos.*temporary/i);
    expect(report.errors.join(' ')).toMatch(/https/);
  });
  it('refuses an unencrypted database connection and a bad proxy count', () => {
    const report = checkProductionConfig({ ...good, DATABASE_SSL: 'disable', TRUST_PROXY_HOPS: 'lots' });
    expect(report.errors).toHaveLength(2);
  });
  it('checks the limits, timeouts and automatic-send hold', () => {
    expect(checkProductionConfig({ ...good, API_LIMIT_PER_SESSION_PER_MINUTE: '0', PG_POOL_MAX: 'many' }).errors).toHaveLength(2);
    expect(checkProductionConfig({ ...good, AUTO_SEND_MIN_DELAY_SECONDS: '5' }).errors.join(' ')).toMatch(/AUTO_SEND_MIN_DELAY_SECONDS/);
    expect(checkProductionConfig({ ...good, AUTO_SEND_MIN_DELAY_SECONDS: '300', API_LIMIT_PER_ADDRESS_PER_MINUTE: '2000' })).toEqual({ errors: [], warnings: [] });
    expect(checkProductionConfig({ ...good, RATE_LIMIT_STORE: 'redis' }).errors.join(' ')).toMatch(/RATE_LIMIT_STORE/);
    expect(checkProductionConfig({ ...good, RATE_LIMIT_STORE: 'memory' }).warnings.join(' ')).toMatch(/multiplied/);
  });
  it('refuses resend without a key', () => {
    expect(checkProductionConfig({ ...good, RESEND_API_KEY: '' }).errors.join(' ')).toMatch(/RESEND_API_KEY/);
  });
  it('turns the same problems into warnings for a public demo, and says demo mode is on', () => {
    const report = checkProductionConfig({ NODE_ENV: 'production', GATHER_DEMO_MODE: 'true', DATABASE_PATH: '/tmp/gather.sqlite', UPLOADS_PATH: '/tmp/up', PUBLIC_BASE_URL: 'https://demo.example.com' });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/Demo mode is on/);
    expect(report.warnings.join(' ')).toMatch(/temporary/);
  });
  it('warns about an unused demo password and a missing mail server', () => {
    const report = checkProductionConfig({ ...good, EMAIL_TRANSPORT: 'smtp', DEMO_PASSWORD: 'x' });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/DEMO_PASSWORD/);
    expect(report.warnings.join(' ')).toMatch(/No mail server/);
  });
  it('never repeats a secret value in its messages', () => {
    const report = checkProductionConfig({ ...good, RESEND_API_KEY: '', DEMO_PASSWORD: 'SuperSecretValue123', DATABASE_URL: 'postgres://user:hunter2@host/db', PUBLIC_BASE_URL: 'http://x' });
    expect(JSON.stringify(report)).not.toMatch(/SuperSecretValue123|hunter2/);
  });
});
