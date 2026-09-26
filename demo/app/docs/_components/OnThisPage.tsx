'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

type Heading = { id: string; text: string; level: 2 | 3 };

/**
 * "On this page": the article's h2/h3 headings, read from the DOM after
 * render so pages never maintain a second list of their own headings. The
 * heading nearest the top of the viewport is highlighted as you scroll.
 */
export default function OnThisPage() {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState('');

  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('.doc-body h2[id], .doc-body h3[id]'),
    );
    // Reading the DOM the page just rendered is the external system here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeadings(
      nodes.map((n) => ({
        id: n.id,
        // The anchor "#" is the first child; the rest is the heading text.
        text: (n.textContent ?? '').replace(/^#/, '').trim(),
        level: n.tagName === 'H3' ? 3 : 2,
      })),
    );
    if (typeof IntersectionObserver === 'undefined' || nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) setActive(visible[0]!.target.id);
      },
      { rootMargin: '-72px 0px -70% 0px' },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [pathname]);

  if (headings.length < 2) return <div className="doc-toc" aria-hidden="true" />;
  return (
    <nav className="doc-toc" aria-label="On this page">
      <p className="doc-toc-title">On this page</p>
      <ul>
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? 'is-sub' : undefined}>
            <a href={`#${h.id}`} className={active === h.id ? 'is-active' : undefined}>
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
