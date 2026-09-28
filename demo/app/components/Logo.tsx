import Link from 'next/link';

/**
 * The unibooking mark: a calendar page (two binding rings over a rounded
 * sheet) with a "u" drawn in it: one calendar, many providers underneath.
 * Colours come from the theme tokens, so the mark follows light and dark mode
 * without a second asset. `app/icon.svg` is the same drawing with fixed
 * colours, for the browser tab.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="4" width="29" height="26.5" rx="7" fill="var(--pine)" />
      <rect x="8" y="1" width="3.4" height="7" rx="1.7" fill="var(--ink)" />
      <rect x="20.6" y="1" width="3.4" height="7" rx="1.7" fill="var(--ink)" />
      <path
        d="M10.5 12.5v5.5a5.5 5.5 0 0 0 11 0v-5.5"
        fill="none"
        stroke="var(--surface)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark + wordmark, linking home. */
export default function Logo({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="site-logo" aria-label="unibooking home">
      <LogoMark size={32} />
      <span className="site-logo-word" aria-hidden="true">
        <span className="site-logo-uni">uni</span>booking
      </span>
    </Link>
  );
}
