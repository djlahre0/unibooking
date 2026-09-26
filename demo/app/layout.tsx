import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Familjen_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import './site.css';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, siteUrl } from '../lib/site';

/* Fonts are downloaded at build time and served from this site: no request to
   Google from the visitor's browser, and no layout shift while they load. A
   remote CSS @import is dropped when Next bundles the stylesheets, so this is
   the only way they reliably reach the page. Each is exposed as a CSS variable
   the stylesheets use. */
const sans = Familjen_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});
/** The wordmark's display face, used for the logo only. */
const brand = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-brand',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: {
    default: `Booking & Calendar API Explorer | ${SITE_NAME}`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'unibooking',
    'booking api',
    'calendar api',
    'unified booking api',
    'scheduling api',
    'typescript',
    'google calendar api',
    'outlook calendar api',
    'caldav',
    'square appointments api',
    'acuity scheduling api',
    'calendly api',
    'mindbody api',
  ],
  authors: [{ name: 'djlahre0', url: 'https://github.com/djlahre0' }],
  creator: 'djlahre0',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_TAGLINE} | ${SITE_NAME}`,
    description: SITE_DESCRIPTION,
    url: '/',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_TAGLINE} | ${SITE_NAME}`,
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
  category: 'technology',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f2f4f3' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1614' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${brand.variable}`}>
      <head>
        {/* Applies the saved theme BEFORE first paint. Without this, a visitor
            who chose Light while their OS is dark sees a dark flash on every
            load, because React only reaches ThemeToggle after hydration.
            Inlined and synchronous by necessity; wrapped in try/catch because
            reading localStorage throws outright when site data is blocked, and
            a colour preference is never worth breaking the page over. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var s=localStorage.getItem('unibooking:demo:ui:v1');if(s){var t=JSON.parse(s).theme;if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
