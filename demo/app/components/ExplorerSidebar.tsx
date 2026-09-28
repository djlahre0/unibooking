'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { PROVIDER_META, isLocal, isDirect } from '../../lib/providers';
import { EXPLORER_GROUPS, EXPLORER_SECTIONS, sectionById } from '../../lib/explorer-sections';
import { tabUnsupported } from '../../lib/provider-picker';
import { PROVIDER_GUIDES } from '../../lib/docs/provider-guides';
import ProviderPicker from './ProviderPicker';
import {
  BadgeIcon,
  BellIcon,
  BookIcon,
  CalendarIcon,
  ChevronIcon,
  ClockIcon,
  GridIcon,
  GroupIcon,
  LinkIcon,
  MapIcon,
  PulseIcon,
  SyncIcon,
  TagIcon,
  TicketIcon,
  UsersIcon,
  WrenchIcon,
} from './icons';

const ICONS: Record<string, ReactNode> = {
  calendar: <CalendarIcon />,
  connect: <LinkIcon />,
  capabilities: <GridIcon />,
  bookings: <TicketIcon />,
  availability: <ClockIcon />,
  customers: <UsersIcon />,
  classes: <GroupIcon />,
  services: <TagIcon />,
  staff: <BadgeIcon />,
  mapping: <MapIcon />,
  sync: <SyncIcon />,
  catalog: <PulseIcon />,
  utilities: <WrenchIcon />,
  webhooks: <BellIcon />,
};

function transportOf(id: string): { tone: string; text: string } | null {
  if (!id) return null;
  if (isLocal(id))
    return { tone: 'indigo', text: 'Sample data on this device, no account, no network.' };
  if (isDirect(id)) return { tone: 'pine', text: 'Your browser calls the provider directly.' };
  return { tone: 'amber', text: 'Blocks browser calls, so requests go via the demo server.' };
}

export type ExplorerSidebarProps = {
  selectedProvider: string;
  onSelectProvider: (id: string) => void;
  activeTab: string;
  onSelectTab: (id: string) => void;
  /** The calendar the Explorer is working on, for calendar providers only. */
  calendar?: CalendarTarget;
};

export type CalendarTarget = {
  /** Short name shown in the row. */
  value: string;
  /** Where it comes from, or what is missing. */
  detail: string;
  /** The full id or URL, for the tooltip. */
  full?: string;
  /** `warn` when no calendar is chosen and one is required. */
  tone: 'ok' | 'warn';
  /** Which section changes it: Connect for pasted credentials, My Calendar
   *  when signed in. */
  changeIn: 'connect' | 'calendar';
};

/** The label a provider id is shown under. */
function labelOf(id: string): string {
  return PROVIDER_META[id]?.label ?? id;
}

export default function ExplorerSidebar({
  selectedProvider,
  onSelectProvider,
  activeTab,
  onSelectTab,
  calendar,
}: ExplorerSidebarProps) {
  // Below 900px the section list folds behind one button; the DOM stays, so
  // the tabs keep working for keyboard and assistive tech either way.
  const [open, setOpen] = useState(false);
  const transport = transportOf(selectedProvider);
  const guide =
    selectedProvider && selectedProvider in PROVIDER_GUIDES
      ? `/docs/providers/${selectedProvider}`
      : undefined;
  const current = sectionById(activeTab);

  const focusTab = (id: string) => {
    onSelectTab(id);
    document.getElementById(`tab-${id}`)?.focus();
  };

  return (
    <aside className="explorer-sidebar" aria-label="Explorer">
      <div className="sidebar-provider">
        <ProviderPicker value={selectedProvider} onChange={onSelectProvider} />
        {transport ? (
          <p className={`sidebar-transport tone-${transport.tone}`}>
            <span className="sidebar-dot" aria-hidden="true" />
            {transport.text}
          </p>
        ) : (
          <p className="sidebar-transport">
            New here? Start with <strong>Sample Data</strong>. It needs no account.
          </p>
        )}
        {calendar && (
          <div className={`sidebar-calendar ${calendar.tone === 'warn' ? 'is-warn' : ''}`}>
            <div className="sidebar-calendar-head">
              <span className="sidebar-calendar-icon" aria-hidden="true">
                <CalendarIcon size={14} />
              </span>
              <span className="sidebar-calendar-label">Calendar</span>
              <button
                type="button"
                className="sidebar-calendar-change"
                onClick={() => onSelectTab(calendar.changeIn)}
                aria-label={`Change calendar in ${calendar.changeIn === 'calendar' ? 'My Calendar' : 'Connect'}`}
              >
                Change
              </button>
            </div>
            <span className="sidebar-calendar-value" title={calendar.full ?? calendar.value}>
              {calendar.value}
            </span>
            <span className="sidebar-calendar-detail">{calendar.detail}</span>
          </div>
        )}
        {/* The selected provider's credentials are always one click away,
            as the header pill used to offer. */}
        <button
          type="button"
          className="sidebar-connect"
          onClick={() => onSelectTab('connect')}
          aria-label={
            selectedProvider
              ? `Provider: ${labelOf(selectedProvider)}. Change it in Connect.`
              : 'No provider selected. Choose one in Connect.'
          }
        >
          <LinkIcon size={14} />
          {selectedProvider ? 'Credentials & connection test' : 'Choose in Connect'}
        </button>
        {guide && (
          <Link className="sidebar-guide" href={guide}>
            <BookIcon size={14} />
            Setup guide for {PROVIDER_GUIDES[selectedProvider as keyof typeof PROVIDER_GUIDES].name}
          </Link>
        )}
      </div>

      <button
        type="button"
        className="sidebar-sections-toggle"
        aria-expanded={open}
        aria-controls="explorer-nav"
        onClick={() => setOpen((o) => !o)}
      >
        <span>
          Section: <strong>{current?.label ?? 'Connect'}</strong>
        </span>
        <ChevronIcon size={14} />
      </button>

      <nav
        id="explorer-nav"
        className="tabs explorer-nav"
        role="tablist"
        aria-label="Sections"
        aria-orientation="vertical"
        data-open={open}
      >
        {EXPLORER_GROUPS.map((group) => (
          <div key={group} className="tab-group" role="presentation">
            <span className="tab-group-label" aria-hidden="true">
              {group}
            </span>
            {EXPLORER_SECTIONS.map((s, i) => {
              if (s.group !== group) return null;
              // Dimmed, not hidden: the section still opens and explains
              // itself, but a glance shows what this provider can't do.
              const unsupported = tabUnsupported(s.id, selectedProvider);
              const selected = activeTab === s.id;
              return (
                <button
                  key={s.id}
                  id={`tab-${s.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  className={`tab ${selected ? 'active' : ''} ${unsupported ? 'tab-muted' : ''}`}
                  title={unsupported || undefined}
                  onClick={() => {
                    onSelectTab(s.id);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    const n = EXPLORER_SECTIONS.length;
                    let idx: number;
                    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') idx = (i + 1) % n;
                    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') idx = (i - 1 + n) % n;
                    else if (e.key === 'Home') idx = 0;
                    else if (e.key === 'End') idx = n - 1;
                    else return;
                    e.preventDefault();
                    focusTab(EXPLORER_SECTIONS[idx]!.id);
                  }}
                >
                  <span className="tab-icon">{ICONS[s.id]}</span>
                  <span className="tab-label">{s.label}</span>
                  {unsupported && (
                    <span className="tab-na" aria-hidden="true">
                      n/a
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <Link href="/docs/quickstart">Quickstart</Link>
        <Link href="/docs/providers">All providers</Link>
        <Link href="/docs/guides/production">Production checklist</Link>
      </div>
    </aside>
  );
}
