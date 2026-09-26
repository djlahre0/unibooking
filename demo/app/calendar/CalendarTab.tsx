'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Booking, Calendar } from 'unibooking';
import type { ActionResult } from '../../lib/result';
import { calendarCall, disconnect, getStatus } from '../../lib/calendar/api';
import {
  dayLabel,
  groupByDay,
  shiftDate,
  todayIn,
  windowRange,
  type WindowDays,
} from '../../lib/calendar/agenda';
import { defaultValues, isValidZone, valuesFromBooking } from '../../lib/calendar/event-form';
import {
  isOAuthProvider,
  PROVIDER_LABELS,
  type CalendarProvider,
  type CalendarStatus,
  type EventInput,
} from '../../lib/calendar/types';
import Agenda from './Agenda';
import CalendarList, { type CalendarActions } from './CalendarList';
import { NoCalendarConnected, SetupNotice } from './CalendarEmptyStates';
import CopyField from './CopyField';
import EventDetails from './EventDetails';
import EventForm from './EventForm';
import { CALENDAR_STORAGE_KEY } from './constants';
import { EVENT_STATUS_LABELS, type EventStatus } from '../../lib/cancel-event';

type Banner = { kind: 'error' | 'success'; text: string; redirectUrl?: string };

/** Fixed codes the OAuth routes put in the URL → what the user reads. Most of
 *  these are this app's own codes (`state_mismatch`, `not_configured`, …),
 *  but the OAuth ones (`invalid_client` on down) are the provider's own
 *  `error` CODE, forwarded as-is by the callback route because -- unlike its
 *  free-text `error_description`, which never reaches here -- the CODE is a
 *  fixed, spec-defined identifier (RFC 6749 §4.1.2.1, §5.2) safe to show
 *  verbatim. Only `access_denied` says "cancelled": every other code is a
 *  real failure the visitor did not choose, and telling them so is the whole
 *  point of this map. */
const URL_ERRORS: Record<string, string> = {
  access_denied: 'Sign-in was cancelled. Nothing was connected.',
  state_mismatch: 'That sign-in could not be verified (it may have expired). Please try again.',
  exchange_failed: 'The provider did not complete the sign-in. Please try again.',
  not_configured: 'That sign-in option is not configured on this deployment.',
  invalid_client:
    'The client ID was rejected by the provider. Double-check the client ID and client secret you registered.',
  unauthorized_client:
    'The client was rejected for this sign-in method. Double-check the client ID and client secret you registered.',
  redirect_uri_mismatch:
    'The redirect URL below is not registered with this OAuth app. Register it exactly, then try again.',
  invalid_scope:
    'A permission this app requested is not enabled for this OAuth app. Check the scopes enabled for it.',
  admin_policy_enforced:
    "Your organisation's admin policy blocks this app from signing in. Ask your workspace admin to allow it.",
  org_internal:
    'This app is restricted to accounts inside one organisation, and yours is not a member of it.',
  disallowed_useragent:
    'The provider blocked sign-in from this browser context. Try again in a standard browser window.',
  server_error:
    'The provider hit an internal error while completing sign-in. Try again in a moment.',
  temporarily_unavailable: 'The provider is temporarily unavailable. Try again shortly.',
  invalid_request:
    "The sign-in request was malformed. Try again, and if it keeps happening, check the app's OAuth setup.",
  // The callback route's own fallback for a provider `error` value that
  // didn't fit the OAuth code shape -- deliberately generic, since nothing
  // about that value was safe to echo in the first place.
  oauth_error: 'Sign-in failed. Please try again.',
};

/** An OAuth 2.0 `error` CODE (not its free-text `error_description`) is safe
 *  to reflect -- see the callback route's own `oauthErrorCode`. This is the
 *  same shape check, run again here: `bannerFromUrl` reads the URL directly,
 *  which a crafted link could set without ever going through that route, so
 *  the page must not trust it just because it arrived in `?error=`. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

/** The exact URL this app expects `provider`'s OAuth app to redirect back to
 *  -- the same computation CustomAppForm.tsx makes, and what the deployment's
 *  own `redirectUri()` builds server-side (lib/calendar/config.ts). Shown
 *  again after `redirect_uri_mismatch` so the fix is right there, not just
 *  named. */
function expectedRedirectUrl(provider: CalendarProvider): string {
  return `${window.location.origin}/api/calendar/callback/${provider}`;
}

function bannerFromUrl(): Banner | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  if (error) {
    if (!OAUTH_ERROR_CODE.test(error)) {
      return { kind: 'error', text: URL_ERRORS.oauth_error! };
    }
    const text = URL_ERRORS[error] ?? `Sign-in failed (${error}). Please try again.`;
    if (error === 'redirect_uri_mismatch') {
      const provider = params.get('provider');
      return {
        kind: 'error',
        text,
        ...(isOAuthProvider(provider) ? { redirectUrl: expectedRedirectUrl(provider) } : {}),
      };
    }
    return { kind: 'error', text };
  }
  const connected = params.get('connected') as CalendarProvider | null;
  if (connected && connected in PROVIDER_LABELS) {
    return { kind: 'success', text: `Connected to ${PROVIDER_LABELS[connected]}.` };
  }
  return null;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function friendly(res: ActionResult): string {
  switch (res.error?.code) {
    case 'AUTH':
      return 'Your connection expired or was revoked. Please reconnect.';
    case 'RATE_LIMIT':
      return 'Too many requests — try again in a moment.';
    case 'CONFLICT':
      return 'This event was changed elsewhere. Reload and try again.';
    case 'NETWORK':
      return 'Could not reach the server. Check your connection and try again.';
    default:
      return res.error?.message ?? 'Something went wrong.';
  }
}

/** The remembered calendar if it still exists, else primary, else the first
 *  one the account can write to. */
function pickCalendar(list: Calendar[], provider: CalendarProvider): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CALENDAR_STORAGE_KEY) ?? 'null') as {
      provider?: string;
      id?: string;
    } | null;
    if (saved?.provider === provider && list.some((c) => c.id === saved.id)) return saved.id!;
  } catch {
    // Storage unavailable or corrupt: fall through to a sensible default.
  }
  return (list.find((c) => c.primary) ?? list.find((c) => !c.readOnly) ?? list[0])?.id ?? null;
}

function remember(provider: CalendarProvider, id: string): void {
  try {
    localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify({ provider, id }));
  } catch {
    // Best effort only.
  }
}

export default function CalendarTab({ onOpenConnect }: { onOpenConnect?: () => void } = {}) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [banner, setBanner] = useState<Banner | null>(bannerFromUrl);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [displayTz, setDisplayTz] = useState(browserZone);
  const [tzInput, setTzInput] = useState(browserZone);
  const [anchor, setAnchor] = useState(() => todayIn(browserZone()));
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const [events, setEvents] = useState<Booking[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [selected, setSelected] = useState<Booking | null>(null);
  const [editing, setEditing] = useState<null | 'new' | Booking>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const connection = status?.connection ?? null;
  const provider = connection?.provider ?? null;
  const selectedCalendar = calendars.find((c) => c.id === selectedId) ?? null;
  const readOnly = selectedCalendar?.readOnly ?? false;

  const resetConnection = useCallback(() => {
    setCalendars([]);
    setSelectedId(null);
    setEvents([]);
    setSelected(null);
    setEditing(null);
  }, []);

  /** True when the result is usable. Otherwise shows why, and on a dead
   *  connection drops back to the connect screen. */
  const accept = useCallback(
    (res: ActionResult): boolean => {
      if (res.reconnect) {
        resetConnection();
        setStatus((s) => (s ? { ...s, connection: null } : s));
        setBanner({
          kind: 'error',
          text: friendly({ ok: false, error: { code: 'AUTH', message: '' } }),
        });
        return false;
      }
      if (!res.ok) {
        setBanner({ kind: 'error', text: friendly(res) });
        return false;
      }
      return true;
    },
    [resetConnection],
  );

  const applyStatus = useCallback((res: ActionResult) => {
    if (res.ok) setStatus(res.data as CalendarStatus);
    else setBanner({ kind: 'error', text: friendly(res) });
  }, []);

  const loadStatus = useCallback(async () => applyStatus(await getStatus()), [applyStatus]);

  // One-shot: consume ?error / ?provider / ?connected (already read into the
  // banner) and fetch who is connected. `provider` only ever rides alongside
  // `error` (see the callback route), but is stripped unconditionally here
  // for the same reason `error` is: it's done its job once the banner has it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('error') || url.searchParams.has('connected')) {
      url.searchParams.delete('error');
      url.searchParams.delete('provider');
      url.searchParams.delete('connected');
      window.history.replaceState(null, '', url.toString());
    }
    let cancelled = false;
    void getStatus().then((res) => {
      if (!cancelled) applyStatus(res);
    });
    return () => {
      cancelled = true;
    };
  }, [applyStatus]);

  // Calendars, whenever the connected account changes.
  const connectionKey = connection
    ? `${connection.provider}:${connection.account.email ?? ''}`
    : '';
  useEffect(() => {
    if (!connectionKey || !provider) return;
    let cancelled = false;
    void (async () => {
      setCalendarsLoading(true);
      const res = await calendarCall('listCalendars', {});
      if (cancelled) return;
      setCalendarsLoading(false);
      if (!accept(res)) return;
      const list = (res.data as { calendars: Calendar[] }).calendars;
      setCalendars(list);
      setSelectedId(pickCalendar(list, provider));
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionKey, provider, accept]);

  // Events, whenever the calendar or the visible window changes.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void (async () => {
      setEventsLoading(true);
      const res = await calendarCall('listEvents', {
        calendarId: selectedId,
        ...windowRange(anchor, windowDays, displayTz),
      });
      if (cancelled) return;
      setEventsLoading(false);
      if (!accept(res)) return;
      const data = res.data as { events: Booking[]; truncated: boolean };
      setEvents(data.events);
      setTruncated(data.truncated);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, anchor, windowDays, displayTz, reloadKey, accept]);

  const days = useMemo(
    () => groupByDay(events, displayTz, anchor, windowDays),
    [events, displayTz, anchor, windowDays],
  );
  const rangeLabel =
    windowDays === 1
      ? dayLabel(anchor)
      : `${dayLabel(anchor)} – ${dayLabel(shiftDate(anchor, windowDays - 1))}`;

  async function save(input: EventInput) {
    if (!selectedId) return;
    if (editing !== 'new' && Object.keys(input).length === 0) {
      setEditing(null);
      return;
    }
    setBusy(true);
    const res =
      editing === 'new'
        ? await calendarCall('createEvent', { calendarId: selectedId, event: input })
        : await calendarCall('updateEvent', {
            calendarId: selectedId,
            id: (editing as Booking).id,
            event: input,
          });
    setBusy(false);
    if (!accept(res)) return;
    setBanner({ kind: 'success', text: editing === 'new' ? 'Event created.' : 'Event updated.' });
    setEditing(null);
    setSelected((res.data as Booking) ?? null);
    setReloadKey((k) => k + 1);
  }

  // Calendars themselves: the provider owns them; these ask it to make,
  // rename or remove one, then re-read the list so it shows the provider's view.
  async function reloadCalendars(select?: string) {
    const res = await calendarCall('listCalendars', {});
    if (!accept(res)) return;
    const list = (res.data as { calendars: Calendar[] }).calendars;
    setCalendars(list);
    const next = select && list.some((c) => c.id === select) ? select : pickCalendar(list, provider!);
    setSelectedId(next);
    if (next) remember(provider!, next);
  }

  const calendarActions: CalendarActions = {
    create: async (input) => {
      setBusy(true);
      const res = await calendarCall('createCalendar', input);
      setBusy(false);
      if (!accept(res)) return false;
      const cal = res.data as Calendar;
      setBanner({ kind: 'success', text: `Calendar “${cal.name}” created.` });
      setSelected(null);
      await reloadCalendars(cal.id);
      return true;
    },
    rename: async (cal, name) => {
      setBusy(true);
      const res = await calendarCall('updateCalendar', { calendarId: cal.id, name });
      setBusy(false);
      if (!accept(res)) return false;
      setBanner({ kind: 'success', text: `Calendar renamed to “${name}”.` });
      await reloadCalendars(cal.id);
      return true;
    },
    remove: async (cal) => {
      if (
        !window.confirm(
          `Delete the calendar “${cal.name}” and every event in it? This can't be undone.`,
        )
      )
        return;
      setBusy(true);
      const res = await calendarCall('deleteCalendar', { calendarId: cal.id });
      setBusy(false);
      if (!accept(res)) return;
      setBanner({ kind: 'success', text: `Calendar “${cal.name}” deleted.` });
      setSelected(null);
      setEditing(null);
      await reloadCalendars();
    },
  };

  // Confirmed / tentative / cancelled. Cancelled keeps the event on the
  // calendar, marked and no longer blocking the time; picking another status
  // restores it. Delete below removes it. See lib/cancel-event.ts.
  async function changeStatus(b: Booking, status: EventStatus) {
    if (!selectedId) return;
    if (
      status === 'cancelled' &&
      !window.confirm(
        `Cancel "${b.title}"? It stays on the calendar marked as cancelled, and guests are notified.`,
      )
    )
      return;
    setBusy(true);
    const res = await calendarCall('setEventStatus', { calendarId: selectedId, id: b.id, status });
    setBusy(false);
    if (!accept(res)) return;
    setSelected((res.data as Booking) ?? null);
    setBanner({
      kind: 'success',
      text:
        status === 'cancelled'
          ? 'Event cancelled. It stays on the calendar, marked cancelled.'
          : `Event marked ${EVENT_STATUS_LABELS[status].toLowerCase()}.`,
    });
    setReloadKey((k) => k + 1);
  }

  async function remove(b: Booking) {
    if (!selectedId) return;
    if (!window.confirm(`Delete "${b.title}"? This cannot be undone.`)) return;
    setBusy(true);
    const res = await calendarCall('deleteEvent', { calendarId: selectedId, id: b.id });
    setBusy(false);
    if (!accept(res)) return;
    setSelected(null);
    setBanner({ kind: 'success', text: 'Event deleted.' });
    setReloadKey((k) => k + 1);
  }

  async function signOut() {
    setBusy(true);
    await disconnect();
    setBusy(false);
    resetConnection();
    setBanner({
      kind: 'success',
      text: 'Disconnected. Your calendar is no longer linked to this browser.',
    });
    await loadStatus();
  }

  const bannerView = banner ? (
    <div
      className={`cal-banner ${banner.kind}`}
      role={banner.kind === 'error' ? 'alert' : 'status'}
    >
      <div className="cal-banner-body">
        <span>{banner.text}</span>
        {banner.redirectUrl ? (
          <CopyField
            id="oauth-redirect-url"
            label="Redirect URL to register"
            value={banner.redirectUrl}
          />
        ) : null}
      </div>
      <button
        type="button"
        className="cal-banner-close"
        aria-label="Dismiss"
        onClick={() => setBanner(null)}
      >
        ×
      </button>
    </div>
  ) : null;

  if (!status) {
    return (
      <div className="fade-in">
        {bannerView}
        <div className="loading">Loading My Calendar…</div>
      </div>
    );
  }

  if (!connection || !provider) {
    // This tab is the user's own calendar, so with nothing connected there is
    // nothing to show. Provider cards and OAuth app setup both live on the
    // Connect tab -- one place to connect anything, rather than two that
    // drift apart.
    return (
      <div className="fade-in">
        {bannerView}
        {!status.enabled ? (
          <SetupNotice {...(status.problem ? { problem: status.problem } : {})} />
        ) : (
          <NoCalendarConnected {...(onOpenConnect ? { onOpenConnect } : {})} />
        )}
      </div>
    );
  }

  const who = connection.account.email ?? connection.account.name ?? 'Connected account';
  return (
    <div className="fade-in">
      {bannerView}
      <div className="card cal-header">
        <div>
          <div className="cal-account">{who}</div>
          <div className="cal-muted">{PROVIDER_LABELS[provider]}</div>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          onClick={signOut}
          disabled={busy}
        >
          Disconnect
        </button>
      </div>

      <div className="cal-layout">
        <CalendarList
          calendars={calendars}
          selectedId={selectedId}
          loading={calendarsLoading}
          busy={busy}
          actions={calendarActions}
          onSelect={(id) => {
            setSelectedId(id);
            remember(provider, id);
            setSelected(null);
            setEditing(null);
          }}
        />
        <div className="cal-column">
          {editing ? (
            <EventForm
              key={editing === 'new' ? 'new' : editing.id}
              mode={editing === 'new' ? 'new' : 'edit'}
              initial={
                editing === 'new' ? defaultValues(displayTz) : valuesFromBooking(editing, displayTz)
              }
              busy={busy}
              onSubmit={(input) => void save(input)}
              onCancel={() => setEditing(null)}
            />
          ) : selected ? (
            <EventDetails
              booking={selected}
              displayTz={displayTz}
              readOnly={readOnly}
              busy={busy}
              onEdit={() => setEditing(selected)}
              onSetStatus={(s) => void changeStatus(selected, s)}
              onDelete={() => void remove(selected)}
              onClose={() => setSelected(null)}
            />
          ) : null}
          <Agenda
            days={days}
            loading={eventsLoading || calendarsLoading}
            truncated={truncated}
            windowDays={windowDays}
            displayTz={tzInput}
            rangeLabel={rangeLabel}
            readOnly={readOnly || !selectedId}
            onPrev={() => setAnchor((a) => shiftDate(a, -windowDays))}
            onToday={() => setAnchor(todayIn(displayTz))}
            onNext={() => setAnchor((a) => shiftDate(a, windowDays))}
            onWindowDays={setWindowDays}
            onDisplayTz={(tz) => {
              setTzInput(tz);
              if (isValidZone(tz)) setDisplayTz(tz);
            }}
            onNew={() => {
              setSelected(null);
              setEditing('new');
            }}
            onOpen={(b) => {
              setEditing(null);
              setSelected(b);
            }}
          />
        </div>
      </div>
    </div>
  );
}
