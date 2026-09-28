'use client';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { searchDocs } from '../../lib/docs/search';
import { ArrowRightIcon, SearchIcon } from './icons';

/**
 * Site search: docs pages, provider guides and Explorer sections. Opens from
 * the header button, ⌘K / Ctrl+K, or "/" when no field has focus. Results are
 * real links, so Enter simply follows the highlighted one, no router needed,
 * and middle-click / open-in-new-tab work as they do anywhere else.
 */
/** "⌘K" on Apple devices, "Ctrl K" elsewhere. The server has no platform to
 *  read, so it renders the Apple form and the client corrects it after
 *  hydration without a mismatch. */
const noSubscribe = () => () => {};
const shortcutLabel = () =>
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K';
const serverShortcutLabel = () => '⌘K';

export default function SearchDialog() {
  const shortcut = useSyncExternalStore(noSubscribe, shortcutLabel, serverShortcutLabel);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const results = useMemo(() => searchDocs(query), [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    // The page behind must not scroll while the dialog is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(0);
  };

  const follow = (i: number) => {
    const link = listRef.current?.querySelectorAll('a')[i];
    link?.click();
  };

  return (
    <>
      <button
        type="button"
        className="site-search-btn"
        onClick={() => setOpen(true)}
        aria-label="Search the docs"
      >
        <SearchIcon size={15} />
        <span className="site-search-label">Search docs…</span>
        <kbd className="site-search-kbd">{shortcut}</kbd>
      </button>

      {open && (
        <div className="search-overlay" onMouseDown={close}>
          <div
            className="search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="search-input-row">
              <SearchIcon size={18} />
              <input
                ref={inputRef}
                className="search-input"
                type="search"
                placeholder="Search guides, providers and the explorer…"
                value={query}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') close();
                  else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, results.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter' && results[active]) {
                    e.preventDefault();
                    follow(active);
                  }
                }}
              />
              <kbd className="site-search-kbd">Esc</kbd>
            </div>
            {results.length === 0 ? (
              <p className="search-empty">No results for “{query}”.</p>
            ) : (
              <ul className="search-results" id={listId} role="listbox" ref={listRef}>
                {results.map((r, i) => (
                  <li
                    key={r.href}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                  >
                    <Link
                      href={r.href}
                      className={`search-result ${i === active ? 'is-active' : ''}`}
                      onClick={close}
                    >
                      <span className="search-result-text">
                        <span className="search-result-title">
                          {r.title}
                          <span className="search-result-group">{r.group}</span>
                        </span>
                        <span className="search-result-desc">{r.description}</span>
                      </span>
                      <ArrowRightIcon size={15} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
