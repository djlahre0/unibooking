'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  PROVIDER_META,
  LOCAL_PROVIDERS,
  DIRECT_PROVIDERS,
  PROXY_PROVIDERS,
  isLocal,
  isDirect,
} from '../../lib/providers';
import { PROVIDER_GUIDES } from '../../lib/docs/provider-guides';
import { ArrowRightIcon, CheckIcon, ChevronIcon, SearchIcon } from './icons';

type Tone = 'indigo' | 'pine' | 'amber';

/** Grouped by how each provider actually runs, read from lib/providers.ts so
 *  the picker can never drift from the transport split the demo relies on. */
const GROUPS: { heading: string; tone: Tone; ids: string[] }[] = [
  { heading: 'Runs on this device', tone: 'indigo', ids: [...LOCAL_PROVIDERS] },
  { heading: 'Runs in your browser', tone: 'pine', ids: [...DIRECT_PROVIDERS] },
  { heading: 'Runs via the demo server', tone: 'amber', ids: [...PROXY_PROVIDERS] },
];

function toneOf(id: string): Tone {
  return isLocal(id) ? 'indigo' : isDirect(id) ? 'pine' : 'amber';
}

function labelOf(id: string): string {
  return PROVIDER_META[id]?.label ?? id;
}

/** One or two letters for the badge: "Google Calendar" → "G", "MS Bookings" → "MB". */
function initials(label: string): string {
  const words = label
    .replace(/[^A-Za-z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const caps = words.filter((w) => /^[A-Z]{2,}$/.test(w));
  if (caps[0]) return caps[0].slice(0, 2);
  return (words[0]?.[0] ?? '?').toUpperCase();
}

/** The second line of an option: what kind of provider it is, and whether
 *  getting access needs more than signing up. */
function detailOf(id: string): string {
  if (isLocal(id)) return 'Sample salon · no account';
  const g = PROVIDER_GUIDES[id as keyof typeof PROVIDER_GUIDES];
  if (!g) return '';
  const kind = g.kind === 'calendar' ? 'Calendar' : 'Booking platform';
  return g.access === 'Self-serve' ? kind : `${kind} · ${g.access}`;
}

function Badge({ id }: { id: string }) {
  return (
    <span className={`picker-badge tone-${toneOf(id)}`} aria-hidden="true">
      {initials(labelOf(id))}
    </span>
  );
}

export type ProviderPickerProps = {
  value: string;
  onChange: (id: string) => void;
};

/**
 * The Explorer's provider picker: a button showing the current provider that
 * opens a searchable, grouped list. A native <select> cannot show where a
 * provider runs, what it is, or filter 18 entries by typing: this can, and
 * keeps the same keyboard model (arrows, Enter, Escape) and ARIA roles
 * (combobox + listbox) a screen reader expects.
 */
export default function ProviderPicker({ value, onChange }: ProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;

  /** Groups after filtering, and the flat order the arrow keys walk. */
  const { groups, flat } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (id: string) =>
      !q || `${labelOf(id)} ${id} ${detailOf(id)}`.toLowerCase().includes(q);
    const gs = GROUPS.map((g) => ({ ...g, ids: g.ids.filter(match) })).filter(
      (g) => g.ids.length > 0,
    );
    return { groups: gs, flat: gs.flatMap((g) => g.ids) };
  }, [query]);

  const openPicker = () => {
    setQuery('');
    setActive(Math.max(0, [...GROUPS.flatMap((g) => g.ids)].indexOf(value)));
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (id: string) => {
    onChange(id);
    close(true);
  };

  // Focus the search field on open; close on a click outside.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted option in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(flat.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const id = flat[active];
      if (id) choose(id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="picker" ref={rootRef}>
      <label className="sidebar-label" htmlFor={`${uid}-trigger`}>
        Provider
      </label>
      <button
        ref={triggerRef}
        id={`${uid}-trigger`}
        type="button"
        className={`picker-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        {value ? (
          <>
            <Badge id={value} />
            <span className="picker-trigger-text">
              <span className="picker-trigger-name">{labelOf(value)}</span>
              <span className="picker-trigger-sub">{detailOf(value)}</span>
            </span>
          </>
        ) : (
          <>
            <span className="picker-badge picker-badge-empty" aria-hidden="true">
              ?
            </span>
            <span className="picker-trigger-text">
              <span className="picker-trigger-name">Choose a provider…</span>
              <span className="picker-trigger-sub">17 providers + sample data</span>
            </span>
          </>
        )}
        <span className="picker-chevron" aria-hidden="true">
          <ChevronIcon size={14} />
        </span>
      </button>

      {open && (
        <div className="picker-panel">
          <div className="picker-search">
            <SearchIcon size={15} />
            <input
              ref={inputRef}
              className="picker-input"
              type="text"
              placeholder="Search providers…"
              aria-label="Search providers"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat[active] ? `${uid}-opt-${flat[active]}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKey}
            />
          </div>

          <ul
            className="picker-list"
            id={listId}
            role="listbox"
            aria-label="Providers"
            ref={listRef}
          >
            {groups.length === 0 && (
              <li className="picker-empty" role="presentation">
                No provider matches “{query}”.
              </li>
            )}
            {groups.map((g) => (
              <li key={g.heading} role="presentation">
                <p className={`picker-group tone-${g.tone}`}>
                  <span className="sidebar-dot" aria-hidden="true" />
                  {g.heading}
                </p>
                <ul role="group" aria-label={g.heading}>
                  {g.ids.map((id) => {
                    const i = flat.indexOf(id);
                    const selected = id === value;
                    return (
                      <li
                        key={id}
                        id={`${uid}-opt-${id}`}
                        role="option"
                        aria-selected={selected}
                        data-index={i}
                        className={`picker-option ${i === active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
                        onMouseEnter={() => setActive(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(id)}
                      >
                        <Badge id={id} />
                        <span className="picker-option-text">
                          <span className="picker-option-name">{labelOf(id)}</span>
                          <span className="picker-option-sub">{detailOf(id)}</span>
                        </span>
                        {selected && (
                          <span className="picker-check" aria-hidden="true">
                            <CheckIcon size={15} />
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <Link className="picker-foot" href="/docs/providers" onClick={() => setOpen(false)}>
            Compare all providers
            <ArrowRightIcon size={14} />
          </Link>
        </div>
      )}
    </div>
  );
}
