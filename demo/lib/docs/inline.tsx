import type { ReactNode } from 'react';

/**
 * The docs' inline markup: `code`, **bold**, _emphasis_ and [text](https://…).
 * Built into React nodes, never into HTML, so no string can inject markup.
 * Anything unmatched is plain text. Links must be absolute http(s) or
 * site-relative (`/docs/…`); anything else renders as its text.
 */
const TOKEN = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w])_([^_]+)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [, code, bold, em, label, href] = m;
    if (code !== undefined) out.push(<code key={key++}>{code}</code>);
    else if (bold !== undefined) out.push(<strong key={key++}>{bold}</strong>);
    else if (em !== undefined) out.push(<em key={key++}>{em}</em>);
    else if (label !== undefined && href !== undefined) {
      const external = /^https?:\/\//.test(href);
      const safe = external || href.startsWith('/');
      out.push(
        safe ? (
          <a
            key={key++}
            href={href}
            {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            {label}
          </a>
        ) : (
          label
        ),
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
