import Link from 'next/link';
import type { ReactNode } from 'react';
import { tokenize } from '@/lib/docs/highlight';
import { neighbours, sectionOf } from '@/lib/docs/nav';
import CopyButton from './CopyButton';
import OnThisPage from './OnThisPage';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BulbIcon,
  InfoIcon,
  WarnIcon,
} from '../../components/icons';

/* ═══════════════════════════════════════════════════════════
   The docs' building blocks. Pages are plain TSX composed from these, so
   every page shares one typography, one code style and one page frame.
   ═══════════════════════════════════════════════════════════ */

/** A heading id from its text: "Get your credentials" → "get-your-credentials". */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The page frame: section eyebrow, title, lead, body, prev/next, and the
 *  "On this page" column built from the body's headings. */
export function DocPage({
  href,
  title,
  lead,
  children,
  badges,
}: {
  href: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  badges?: ReactNode;
}) {
  const section = sectionOf(href);
  const { prev, next } = neighbours(href);
  return (
    <div className="doc-layout">
      <article className="doc-article">
        {section && <p className="doc-eyebrow">{section}</p>}
        <h1 className="doc-title">{title}</h1>
        {lead && <p className="doc-lead">{lead}</p>}
        {badges && <div className="doc-badges">{badges}</div>}
        <div className="doc-body">{children}</div>
        {(prev || next) && (
          <nav className="doc-pager" aria-label="Previous and next page">
            {prev ? (
              <Link className="doc-pager-link" href={prev.href}>
                <span className="doc-pager-dir">
                  <ArrowLeftIcon size={14} /> Previous
                </span>
                <span className="doc-pager-title">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link className="doc-pager-link is-next" href={next.href}>
                <span className="doc-pager-dir">
                  Next <ArrowRightIcon size={14} />
                </span>
                <span className="doc-pager-title">{next.title}</span>
              </Link>
            )}
          </nav>
        )}
      </article>
      <OnThisPage />
    </div>
  );
}

export function H2({ children, id }: { children: ReactNode; id?: string }) {
  const anchor = id ?? slug(typeof children === 'string' ? children : String(children));
  return (
    <h2 id={anchor} className="doc-h2">
      <a className="doc-anchor" href={`#${anchor}`} aria-label={`Link to this section`}>
        #
      </a>
      {children}
    </h2>
  );
}

export function H3({ children, id }: { children: ReactNode; id?: string }) {
  const anchor = id ?? slug(typeof children === 'string' ? children : String(children));
  return (
    <h3 id={anchor} className="doc-h3">
      <a className="doc-anchor" href={`#${anchor}`} aria-label={`Link to this section`}>
        #
      </a>
      {children}
    </h3>
  );
}

/** A code block with a language label, highlighting and a copy button. */
export function Code({
  children,
  lang = 'ts',
  title,
}: {
  children: string;
  lang?: string;
  title?: string;
}) {
  const code = children.replace(/^\n+|\s+$/g, '');
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-title">{title ?? LANG_LABEL[lang] ?? lang}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-pre">
        <code>
          {tokenize(code, lang).map((t, i) =>
            t.type === 'text' ? (
              t.text
            ) : (
              <span key={i} className={`tok-${t.type}`}>
                {t.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

const LANG_LABEL: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  bash: 'Terminal',
  json: 'JSON',
  env: '.env',
};

const CALLOUT_ICON = {
  note: <InfoIcon size={16} />,
  tip: <BulbIcon size={16} />,
  warning: <WarnIcon size={16} />,
};

export function Callout({
  type = 'note',
  title,
  children,
}: {
  type?: 'note' | 'tip' | 'warning';
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className={`callout callout-${type}`}>
      <span className="callout-icon">{CALLOUT_ICON[type]}</span>
      <div className="callout-body">
        {title && <p className="callout-title">{title}</p>}
        {children}
      </div>
    </aside>
  );
}

/** Numbered steps with a rule down the left edge. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="doc-steps">{children}</ol>;
}

export function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="doc-step">
      <p className="doc-step-title">{title}</p>
      <div className="doc-step-body">{children}</div>
    </li>
  );
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="doc-cards">{children}</div>;
}

export function Card({
  href,
  title,
  icon,
  children,
}: {
  href: string;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const external = /^https?:\/\//.test(href);
  const body = (
    <>
      {icon && <span className="doc-card-icon">{icon}</span>}
      <span className="doc-card-title">
        {title}
        <ArrowRightIcon size={14} />
      </span>
      <span className="doc-card-text">{children}</span>
    </>
  );
  return external ? (
    <a className="doc-card" href={href} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <Link className="doc-card" href={href}>
      {body}
    </Link>
  );
}

/** A small pill: "Self-serve", "OAuth 2.0", "Runs in the browser". */
export function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`pill ${tone ? `pill-${tone}` : ''}`}>{children}</span>;
}
