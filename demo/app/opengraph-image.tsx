import { ImageResponse } from 'next/og';
import { SITE_NAME, SITE_TAGLINE } from '../lib/site';

/** The social card shown when a link to any page is shared. Drawn from the
 *  same mark as the logo, in the light theme's colours. */
export const alt = `${SITE_NAME}: ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const PROVIDERS = ['Google', 'Outlook', 'iCloud', 'Square', 'Acuity', 'Calendly', 'Mindbody'];

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 80px',
        background: '#f2f4f3',
        color: '#12211f',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <svg width="76" height="76" viewBox="0 0 32 32">
          <rect x="1.5" y="4" width="29" height="26.5" rx="7" fill="#0f5c4a" />
          <rect x="8" y="1" width="3.4" height="7" rx="1.7" fill="#12211f" />
          <rect x="20.6" y="1" width="3.4" height="7" rx="1.7" fill="#12211f" />
          <path
            d="M10.5 12.5v5.5a5.5 5.5 0 0 0 11 0v-5.5"
            fill="none"
            stroke="#ffffff"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
        </svg>
        <div style={{ display: 'flex', fontSize: 60, fontWeight: 700, letterSpacing: -2 }}>
          <span style={{ color: '#0f5c4a' }}>uni</span>
          <span>booking</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.1, letterSpacing: -2 }}>
          {SITE_TAGLINE}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {PROVIDERS.map((p) => (
            <div
              key={p}
              style={{
                padding: '8px 20px',
                borderRadius: 999,
                background: '#e3ece8',
                color: '#0f5c4a',
                fontSize: 28,
              }}
            >
              {p}
            </div>
          ))}
          <div style={{ padding: '8px 20px', fontSize: 28, color: '#4a5c58' }}>and 10 more</div>
        </div>
      </div>
    </div>,
    size,
  );
}
