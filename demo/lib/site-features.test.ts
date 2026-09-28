import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from './call';
import sitemap from '../app/sitemap';
import robots from '../app/robots';
import { docMetadata } from './docs/meta';
import { DOC_PAGES } from './docs/nav';
import { siteUrl } from './site';

afterEach(() => vi.unstubAllEnvs());

describe('Bookeo webhook verification in the explorer', () => {
  const fields = {
    secretKey: 'app-secret',
    timestamp: '1790000000000',
    messageId: 'msg-1',
    webhookUrl: 'https://app.example.com/webhooks/bookeo',
    body: '{"itemId":"B1"}',
  };
  // Bookeo signs timestamp + messageId + webhookUrl + body with HMAC-SHA256 (hex).
  const signature = createHmac('sha256', fields.secretKey)
    .update(fields.timestamp + fields.messageId + fields.webhookUrl + fields.body)
    .digest('hex');

  it('accepts a correct signature', async () => {
    const r = await verifyWebhook('bookeo', { ...fields, signature });
    expect(r).toEqual({ ok: true, data: { provider: 'bookeo', verified: true } });
  });

  it('rejects a tampered body', async () => {
    const r = await verifyWebhook('bookeo', { ...fields, body: '{"itemId":"B2"}', signature });
    expect(r.ok && (r.data as { verified: boolean }).verified).toBe(false);
  });
});

describe('SEO', () => {
  it('lists the explorer and every docs page in the sitemap, on the public origin', () => {
    vi.stubEnv('APP_URL', 'https://unibooking.example.com');
    const urls = sitemap().map((e) => e.url);
    expect(urls[0]).toBe('https://unibooking.example.com/');
    expect(urls).toContain('https://unibooking.example.com/docs/quickstart');
    expect(urls).toContain('https://unibooking.example.com/docs/providers/square');
    expect(urls).toHaveLength(DOC_PAGES.length + 1);
  });

  it('keeps crawlers out of the API and points them at the sitemap', () => {
    vi.stubEnv('APP_URL', 'https://unibooking.example.com');
    const r = robots();
    expect(r.rules).toMatchObject({ allow: '/', disallow: '/api/' });
    expect(r.sitemap).toBe('https://unibooking.example.com/sitemap.xml');
  });

  it('falls back to localhost for a missing or malformed APP_URL', () => {
    vi.stubEnv('APP_URL', 'not a url');
    expect(siteUrl().origin).toBe('http://localhost:3000');
  });

  it('gives each docs page a complete share card and its own canonical URL', () => {
    const m = docMetadata({
      title: 'Quickstart',
      description: 'Start here.',
      href: '/docs/quickstart',
    });
    expect(m.title).toBe('Quickstart');
    expect(m.alternates).toEqual({ canonical: '/docs/quickstart' });
    expect(m.openGraph).toMatchObject({
      title: 'Quickstart | unibooking',
      description: 'Start here.',
      url: '/docs/quickstart',
      siteName: 'unibooking',
      images: [
        { url: '/opengraph-image', width: 1200, height: 630, alt: 'Quickstart | unibooking' },
      ],
    });
  });
});
