'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Logo from './Logo';
import SearchDialog from './SearchDialog';
import ThemeToggle from '../ThemeToggle';
import { GitHubIcon, NpmIcon } from './icons';

const NAV = [
  { label: 'Explorer', href: '/', match: (p: string) => p === '/' },
  {
    label: 'Docs',
    href: '/docs',
    match: (p: string) => p.startsWith('/docs') && !p.startsWith('/docs/providers'),
  },
  { label: 'Providers', href: '/docs/providers', match: (p: string) => p.startsWith('/docs/providers') },
];

/**
 * The one header every page shares: brand, the three places a visitor goes
 * (try it, read about it, set up a provider), search, and project links.
 * `usePathname` is null outside the App Router (unit tests render pages
 * bare), which reads as the Explorer: the page those tests render.
 */
export default function SiteHeader() {
  const pathname = usePathname() ?? '/';
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Logo />
        <nav className="site-nav" aria-label="Primary">
          {NAV.map((n) => {
            const active = n.match(pathname);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`site-nav-link ${active ? 'is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="site-header-actions">
          <SearchDialog />
          <a
            className="icon-link"
            href="https://github.com/djlahre0/unibooking"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub repository"
            title="GitHub repository"
          >
            <GitHubIcon />
          </a>
          <a
            className="icon-link icon-link-npm"
            href="https://www.npmjs.com/package/unibooking"
            target="_blank"
            rel="noreferrer"
            aria-label="npm package"
            title="npm package"
          >
            <NpmIcon size={20} />
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
