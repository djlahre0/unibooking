'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOC_SECTIONS } from '@/lib/docs/nav';
import { ChevronIcon, TerminalIcon } from '../../components/icons';

/**
 * The docs' left navigation, straight from `lib/docs/nav.ts`. On a phone it
 * folds behind one "Menu" button so the article comes first.
 */
export default function DocsSidebar() {
  const pathname = usePathname() ?? '/docs';
  const [open, setOpen] = useState(false);
  const current = DOC_SECTIONS.flatMap((s) => s.items).find((p) => p.href === pathname);

  return (
    <aside className="docs-sidebar" aria-label="Documentation">
      <button
        type="button"
        className="sidebar-sections-toggle"
        aria-expanded={open}
        aria-controls="docs-nav"
        onClick={() => setOpen((o) => !o)}
      >
        <span>
          Docs: <strong>{current?.title ?? 'Menu'}</strong>
        </span>
        <ChevronIcon size={14} />
      </button>
      <nav id="docs-nav" className="docs-nav" data-open={open}>
        {DOC_SECTIONS.map((section) => (
          <div className="docs-nav-group" key={section.title}>
            <p className="docs-nav-heading">{section.title}</p>
            <ul>
              {section.items.map((item) => {
                const active = item.href === pathname;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`docs-nav-link ${active ? 'is-active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                    >
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <Link className="docs-nav-cta" href="/">
          <TerminalIcon size={15} />
          Open the Explorer
        </Link>
      </nav>
    </aside>
  );
}
