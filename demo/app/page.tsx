'use client';

import { useState, useCallback, useMemo, useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { type ActionResult, getCapabilities } from '../lib/call';
import { PROVIDER_META as PROVIDERS, isLocal } from '../lib/providers';
import { ENVIRONMENTS } from '../lib/environments';
import { resetSample } from '../lib/sample/store';
import { todayIn, shiftDate } from '../lib/calendar/agenda';
import { getStatus } from '../lib/calendar/api';
import type { CalendarStatus } from '../lib/calendar/types';
import {
  loadState,
  saveProvider,
  clearProvider,
  clearAll,
  storageAvailable,
  setRemember as persistRemember,
  DEFAULT_REMEMBER,
} from '../lib/cred-storage';
import {
  patchUiState,
  loadUiState,
  resultForStorage,
  isTooLarge,
  type UiState,
} from '../lib/ui-state';
import { useUiState } from '../lib/use-ui-state';
import ConnectPanel from './ConnectPanel';
import EnvironmentControl from './EnvironmentControl';
import PersistenceControls from './PersistenceControls';
import CalendarTab from './calendar/CalendarTab';
import CapabilitiesTab from './tabs/CapabilitiesTab';
import BookingsTab from './tabs/BookingsTab';
import AvailabilityTab from './tabs/AvailabilityTab';
import CustomersTab from './tabs/CustomersTab';
import CatalogTab from './tabs/CatalogTab';
import ClassesTab from './tabs/ClassesTab';
import ServicesTab from './tabs/ServicesTab';
import StaffTab from './tabs/StaffTab';
import MappingTab from './tabs/MappingTab';
import CalendarSyncTab from './tabs/CalendarSyncTab';
import UtilitiesTab from './tabs/UtilitiesTab';
import WebhooksTab from './tabs/WebhooksTab';
import SiteHeader from './components/SiteHeader';
import ExplorerSidebar, { type CalendarTarget } from './components/ExplorerSidebar';
import { BookIcon } from './components/icons';
import { EXPLORER_SECTIONS, sectionById } from '../lib/explorer-sections';

/** Shared empty object, so `creds` keeps a stable identity across renders. */
const EMPTY_CREDS: Record<string, string> = {};

/** Result slots, keyed exactly as `wrap`'s `section` argument, so the stored
 *  results and the elapsed-time map can never drift apart. */
const RESULT_KEYS = [
  'caps',
  'booking',
  'avail',
  'customer',
  'classes',
  'services',
  'staff',
  'mapping',
  'catalog',
  'util',
  'webhook',
];

/**
 * A stored result, back as an ActionResult. A payload too large to save comes
 * back as a plain error whose message says so: ResultBox already renders
 * `error.message`, so nothing there needs to know about this. Parse failures
 * yield null rather than throwing: a hand-edited localStorage must never
 * white-screen the page.
 */
function savedResult(state: UiState, key: string): ActionResult | null {
  const entry = state.results[key];
  if (!entry) return null;
  if (isTooLarge(entry)) {
    return {
      ok: false,
      error: {
        code: 'NOT_SAVED',
        message: 'This result was too large to save (over 64 KB). Run it again to see it.',
      },
    };
  }
  try {
    return JSON.parse(entry.json) as ActionResult;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   Mount-time client state

   localStorage and the URL do not exist during the server render, so reading
   them in a `useState` initializer would make the first client render disagree
   with the server HTML. `useSyncExternalStore` takes a separate server
   snapshot: hydration matches the HTML, then React immediately re-renders with
   the real values. https://react.dev/reference/react/useSyncExternalStore
   ═══════════════════════════════════════════════════════════ */
type MountState = { storageOk: boolean; remember: boolean };

const SERVER_MOUNT_STATE: MountState = { storageOk: true, remember: DEFAULT_REMEMBER };

// Cached module-side, because `getSnapshot` must return a referentially stable
// value or React re-renders forever.
let clientMountState: MountState | null = null;

function readMountState(): MountState {
  clientMountState ??= {
    storageOk: storageAvailable(),
    remember: loadState().remember,
  };
  return clientMountState;
}

// These are read once at mount and never change underneath us; later edits go
// through the override state in the component below.
const neverChanges = () => () => {};
const readServerMountState = () => SERVER_MOUNT_STATE;

/* ═══════════════════════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════════════════════ */
export default function Home() {
  const mounted = useSyncExternalStore(neverChanges, readMountState, readServerMountState);

  // What the visitor was last doing. Never holds a credential: those stay in
  // cred-storage behind its opt-in toggle. See lib/ui-state.ts.
  const ui = useUiState();

  // A tab saved by an older version may no longer exist ('staffsvc' became
  // Services + Staff); fall back rather than render an empty page.
  const activeTab = EXPLORER_SECTIONS.some((t) => t.id === ui.activeTab)
    ? ui.activeTab
    : ui.activeTab === 'staffsvc'
      ? 'services'
      : 'connect';
  const setActiveTab = useCallback((tab: string) => {
    patchUiState({ activeTab: tab });
  }, []);

  // `?? mounted.x` keeps the mount-time value until the user changes it.
  const [rememberOverride, setRemember_] = useState<boolean | null>(null);
  const remember = rememberOverride ?? mounted.remember;
  const storageOk = mounted.storageOk;

  const selectedProvider = ui.selectedProvider;
  const env = ui.env;
  const baseUrl = ui.baseUrl;
  // Credentials live in cred-storage (opt-in) and NEVER in the UI store. They
  // are DERIVED per provider rather than held in one flat state object: the
  // selected provider is restored from the store after mount, and a flat
  // `creds` would be momentarily blank for a provider that has a saved entry
  // which the debounced save effect below reads as "every field is empty"
  // and answers with clearProvider(), silently deleting what the visitor
  // asked to be remembered. Deriving also avoids a setState-in-effect
  // cascade. `credEdits` holds only what has been typed this session.
  const [credEdits, setCredEdits] = useState<Record<string, Record<string, string>>>({});
  const creds = useMemo(
    () =>
      credEdits[selectedProvider] ?? loadState().providers[selectedProvider]?.creds ?? EMPTY_CREDS,
    [credEdits, selectedProvider],
  );
  const [loadingSection, setLoadingSection] = useState('');
  const busy = (s: string) => loadingSection === s;

  // Whether the visitor is signed in via My Calendar, and to which providers
  // this deployment even offers it -- fetched once here (not by call.ts on
  // every call) so ConnectPanel can lead with a sign-in button and, below,
  // `conn.signedIn` can route the explorer tabs to the session transport
  // instead of the pasted-credential one, for exactly that one connected
  // provider.
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus | null>(null);
  const refreshCalendarStatus = useCallback(() => {
    void getStatus().then((res) => {
      if (res.ok) setCalendarStatus(res.data as CalendarStatus);
    });
  }, []);
  useEffect(() => {
    refreshCalendarStatus();
  }, [refreshCalendarStatus]);

  // Deep links: the calendar OAuth callback lands on /?tab=calendar, and the
  // docs and search link straight to /?tab=<section> or /?provider=<id>.
  // Those must win over whatever was persisted, otherwise a returning
  // visitor is bounced away from the calendar they just connected, or from
  // the section they clicked through to. Adopting them INTO the store (rather
  // than holding them as a separate source of truth) also means a later
  // reload stays put. Read in an effect, never during render: `window` does
  // not exist on the server, so reading it while rendering would break
  // hydration.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const provider = params.get('provider');
    const patch: Partial<UiState> = {};
    if (tab && EXPLORER_SECTIONS.some((t) => t.id === tab)) patch.activeTab = tab;
    if (
      provider &&
      Object.hasOwn(PROVIDERS, provider) &&
      provider !== loadUiState().selectedProvider
    ) {
      const saved = loadState().providers[provider];
      patch.selectedProvider = provider;
      patch.env = saved?.env ?? 'prod';
      patch.baseUrl = saved?.baseUrl ?? ENVIRONMENTS[provider]?.prod ?? '';
      // Same rule as selectProvider: a result from the previous provider must
      // never be shown under the new one.
      patch.results = {};
    }
    if (Object.keys(patch).length > 0) patchUiState(patch);
  }, []);

  /* Results: derived from the store, overridden by this session's live calls.
     Derived rather than held in `useState` + adopted in an effect for the same
     reason as `creds` above: the store's real values only arrive on the render
     AFTER hydration, and adopting them with setState in an effect is both a
     cascading render and an eslint error. `resultEdits` wins whenever a key is
     present in it, including when its value is deliberately null. */
  const [resultEdits, setResultEdits] = useState<Record<string, ActionResult | null>>({});
  const savedResults = useMemo(() => {
    const out: Record<string, ActionResult | null> = {};
    for (const key of RESULT_KEYS) out[key] = savedResult(ui, key);
    return out;
  }, [ui]);
  const resultOf = (key: string): ActionResult | null =>
    key in resultEdits ? resultEdits[key] : (savedResults[key] ?? null);

  // One writer for every result slot, so a new tab cannot forget to persist.
  const setResult = useCallback((key: string, r: ActionResult | null) => {
    setResultEdits((prev) => ({ ...prev, [key]: r }));
    const results = { ...loadUiState().results };
    if (r === null) delete results[key];
    else results[key] = resultForStorage(JSON.stringify(r));
    patchUiState({ results });
  }, []);

  const capsResult = resultOf('caps');
  const bookingResult = resultOf('booking');
  const availResult = resultOf('avail');
  const customerResult = resultOf('customer');
  const classesResult = resultOf('classes');
  const servicesResult = resultOf('services');
  const staffResult = resultOf('staff');
  const mappingResult = resultOf('mapping');
  const catalogResult = resultOf('catalog');
  const utilResult = resultOf('util');
  const webhookResult = resultOf('webhook');

  const setCapsResult = useCallback((r: ActionResult | null) => setResult('caps', r), [setResult]);
  const setBookingResult = useCallback(
    (r: ActionResult | null) => setResult('booking', r),
    [setResult],
  );
  const setAvailResult = useCallback(
    (r: ActionResult | null) => setResult('avail', r),
    [setResult],
  );
  const setCustomerResult = useCallback(
    (r: ActionResult | null) => setResult('customer', r),
    [setResult],
  );
  const setClassesResult = useCallback(
    (r: ActionResult | null) => setResult('classes', r),
    [setResult],
  );
  const setServicesResult = useCallback(
    (r: ActionResult | null) => setResult('services', r),
    [setResult],
  );
  const setStaffResult = useCallback(
    (r: ActionResult | null) => setResult('staff', r),
    [setResult],
  );
  const setMappingResult = useCallback(
    (r: ActionResult | null) => setResult('mapping', r),
    [setResult],
  );
  const setCatalogResult = useCallback(
    (r: ActionResult | null) => setResult('catalog', r),
    [setResult],
  );
  const setUtilResult = useCallback((r: ActionResult | null) => setResult('util', r), [setResult]);
  const setWebhookResult = useCallback(
    (r: ActionResult | null) => setResult('webhook', r),
    [setResult],
  );

  /** Wipes every result, in state and in storage, in ONE store write. */
  const clearAllResults = useCallback(() => {
    setResultEdits(Object.fromEntries(RESULT_KEYS.map((k) => [k, null])));
    patchUiState({ results: {} });
  }, []);

  // How long each section's last call took, keyed the same as `wrap`'s
  // `section` argument. Kept separate from the ActionResult states above --
  // ResultBox takes it as its own prop rather than a field on ActionResult,
  // because that type is also produced by the server proxy route and by
  // serializeError, neither of which knows the browser-side wall-clock time.
  const [elapsedMs, setElapsedMs] = useState<Record<string, number>>({});

  const updateCred = useCallback(
    (key: string, value: string) =>
      setCredEdits((prev) => ({
        ...prev,
        [selectedProvider]: {
          // Seed from storage on the first keystroke so editing one field does
          // not drop the others that were restored alongside it.
          ...(prev[selectedProvider] ?? loadState().providers[selectedProvider]?.creds ?? {}),
          [key]: value,
        },
      })),
    [selectedProvider],
  );

  const wrap = useCallback(
    async (section: string, fn: () => Promise<ActionResult>, setter: (r: ActionResult) => void) => {
      setLoadingSection(section);
      const startedAt = performance.now();
      try {
        const result = await fn();
        setter(result);
      } catch (e) {
        setter({ ok: false, error: { message: String(e) } });
      } finally {
        setElapsedMs((prev) => ({ ...prev, [section]: performance.now() - startedAt }));
        setLoadingSection('');
      }
    },
    [],
  );

  // Default window for List Bookings / withRetry / collectAll / listAll: the
  // sample seed anchors to today and spans today-7 to today+21 (seed.ts), so a
  // hardcoded past week returned nothing on the first click -- and a real
  // provider is no better off defaulting to a fixed date that recedes further
  // into the past every day. Computed once per mount, not per render, so it
  // never clobbers a value the visitor has typed in; every call site reads
  // the same object so they can't drift apart. 'UTC' (not the visitor's own
  // zone) keeps this identical between the server-rendered `defaultValue` and
  // the client's hydration pass -- the server has no access to the browser's
  // timezone, and getting that wrong would fail hydration instead of just
  // being off by a few hours, which is harmless for a default this wide.
  const defaultRange = useMemo(() => {
    const today = todayIn('UTC');
    const tomorrow = shiftDate(today, 1);
    return {
      // The wide window, for List Bookings / withRetry / collectAll / listAll.
      start: `${shiftDate(today, -7)}T00:00:00Z`,
      end: `${shiftDate(today, 21)}T00:00:00Z`,
      // A single upcoming day, for Search Availability. Tomorrow rather than
      // today so a visitor arriving late in the day still sees a full day of
      // slots instead of a mostly-elapsed one.
      dayStart: `${tomorrow}T00:00:00Z`,
      dayEnd: `${shiftDate(today, 2)}T00:00:00Z`,
      // A concrete 45-minute slot tomorrow, for Create Booking.
      slotStart: `${tomorrow}T10:00:00Z`,
      slotEnd: `${tomorrow}T10:45:00Z`,
    };
  }, []);

  const providerInfo = selectedProvider ? PROVIDERS[selectedProvider] : null;
  const conn = useMemo(() => {
    const prod = selectedProvider ? ENVIRONMENTS[selectedProvider]?.prod : undefined;
    // Suppress baseUrl when it matches the provider's production default so the
    // adapter falls back to its own built-in default instead of an explicit
    // override. This has a surprising consequence: Phorest's `eu` region URL is
    // byte-identical to its `prod` URL, so selecting "eu" sends no override at
    // all: the UI shows `eu` selected while the outgoing request carries no
    // explicit host. That's correct (the table's `prod` is contractually equal
    // to the adapter's default, enforced by environments-drift.test.ts) but
    // non-obvious, hence this note.
    //
    // signedIn: true only for the one provider (google or outlook) the
    // visitor is actually connected to via My Calendar right now -- never for
    // any other provider, even another OAuth one, since only one session
    // cookie exists at a time. call.ts's run() checks this before anything
    // else and, when true, ignores creds/baseUrl entirely in favour of the
    // sealed session cookie.
    const signedIn =
      (selectedProvider === 'google' || selectedProvider === 'outlook') &&
      calendarStatus?.connection?.provider === selectedProvider;
    return { creds, baseUrl: !baseUrl || baseUrl === prod ? undefined : baseUrl, signedIn };
  }, [creds, baseUrl, selectedProvider, calendarStatus]);

  useEffect(() => {
    if (!remember || !selectedProvider) return;
    const t = setTimeout(() => {
      const hasValue = Object.values(creds).some((v) => v.trim() !== '');
      if (hasValue) {
        saveProvider(selectedProvider, { creds, env, baseUrl });
      } else {
        // Every field is empty/whitespace: keep storage in sync by removing
        // the entry instead of writing back an empty one. This is what makes
        // "Clear this provider" and "Clear all saved" stick: those handlers
        // reset `creds` to {}, which lands here 300ms later.
        clearProvider(selectedProvider);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [remember, selectedProvider, creds, env, baseUrl]);

  // Shared by every provider picker in the shell (rail, mobile <select>, and
  // ConnectPanel's own chip grid) so switching providers behaves identically
  // no matter which control triggered it.
  const selectProvider = useCallback(
    (id: string) => {
      // Re-selecting the already-selected provider is a no-op, not a switch:
      // running the reset below would blank creds the user just typed
      // (Remember off means nothing was saved yet to reload from).
      if (id === selectedProvider) return;
      // Flush a pending save for the OUTGOING provider before switching:
      // otherwise the debounce effect's cleanup just clearTimeout()s it and
      // credentials typed within the last ~300ms are silently lost. Capture
      // the outgoing values now, before any setter below changes them.
      const outgoingProvider = selectedProvider;
      const outgoingCreds = creds;
      const outgoingEnv = env;
      const outgoingBaseUrl = baseUrl;
      if (
        remember &&
        outgoingProvider &&
        Object.values(outgoingCreds).some((v) => v.trim() !== '')
      ) {
        saveProvider(outgoingProvider, {
          creds: outgoingCreds,
          env: outgoingEnv,
          baseUrl: outgoingBaseUrl,
        });
      }
      const saved = loadState().providers[id];
      // No creds reset needed: `creds` derives from credEdits[id] falling back
      // to this provider's own saved entry, so switching already shows the
      // right values, and any edits typed for the incoming provider earlier
      // in this session are preserved rather than silently dropped.
      patchUiState({
        selectedProvider: id,
        env: saved?.env ?? 'prod',
        baseUrl: saved?.baseUrl ?? ENVIRONMENTS[id]?.prod ?? '',
      });
      // A result from the previous provider must never be shown under the new
      // one. Cleared in a single store write rather than one per tab.
      clearAllResults();
    },
    [selectedProvider, creds, env, baseUrl, remember, clearAllResults],
  );

  const section = sectionById(activeTab);

  // Which calendar the explorer's calls land on, for the three calendar
  // providers. Signed in through My Calendar, the explore route targets the
  // account's primary calendar; with pasted credentials it is the
  // calendarId / calendarUrl field, whose absence means the provider's
  // default, except on Apple, where a collection URL is required.
  const calendarTarget = ((): CalendarTarget | undefined => {
    if (!['google', 'outlook', 'apple'].includes(selectedProvider)) return undefined;
    if (conn.signedIn) {
      const who = calendarStatus?.connection?.account;
      return {
        value: 'Primary calendar',
        detail: `Signed in${who?.email || who?.name ? ` as ${who.email ?? who.name}` : ''}`,
        tone: 'ok',
        changeIn: 'calendar',
      };
    }
    if (selectedProvider === 'apple') {
      const url = creds.calendarUrl?.trim();
      if (!url) {
        return {
          value: 'None chosen',
          detail: 'Required for events: find one with listCalendars',
          tone: 'warn',
          changeIn: 'connect',
        };
      }
      const segment = url.replace(/\/+$/, '').split('/').pop() ?? url;
      let name = segment;
      try {
        name = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment.
      }
      return { value: name, detail: 'calendarUrl', full: url, tone: 'ok', changeIn: 'connect' };
    }
    const id = creds.calendarId?.trim();
    if (!id || id === 'primary') {
      return {
        value: selectedProvider === 'google' ? 'Primary calendar' : 'Default calendar',
        detail: id ? 'calendarId: primary' : 'Default: set calendarId to change',
        tone: 'ok',
        changeIn: 'connect',
      };
    }
    return { value: id, detail: 'calendarId', full: id, tone: 'ok', changeIn: 'connect' };
  })();

  return (
    <div className="app-shell">
      <SiteHeader />
      <div className="explorer-shell">
        <ExplorerSidebar
          selectedProvider={selectedProvider}
          onSelectProvider={selectProvider}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          calendar={calendarTarget}
        />

        <main className="explorer-main" id="main">
          {section && (
            <div className="explorer-head">
              <div className="explorer-head-text">
                <p className="explorer-eyebrow">
                  Explorer · {section.group}
                  {selectedProvider && (
                    <>
                      {' · '}
                      <span className="explorer-provider">
                        {providerInfo?.label ?? selectedProvider}
                      </span>
                    </>
                  )}
                </p>
                <h1 className="explorer-title">{section.label}</h1>
                <p className="explorer-desc">{section.description}</p>
              </div>
              <Link className="explorer-doc-link" href={section.doc}>
                <BookIcon size={14} />
                Read the docs
              </Link>
            </div>
          )}

          {/* ═══ CONNECT TAB ═══ */}
          {activeTab === 'calendar' && (
            <CalendarTab onOpenConnect={() => setActiveTab('connect')} />
          )}

          {activeTab === 'connect' && (
            <ConnectPanel
              onOpenCalendar={() => setActiveTab('calendar')}
              selectedProvider={selectedProvider}
              onSelectProvider={selectProvider}
              creds={creds}
              onCredChange={updateCred}
              capsResult={capsResult}
              onLoadCapabilities={() =>
                wrap('caps', () => getCapabilities(selectedProvider), setCapsResult)
              }
              busy={busy('caps')}
              capsElapsedMs={elapsedMs.caps}
              conn={conn}
              env={env}
              calendarStatus={calendarStatus}
              onDisconnected={refreshCalendarStatus}
              onCalendarConfigChanged={refreshCalendarStatus}
              // ENVIRONMENTS has no entry for the local provider -- it has no
              // host. Passed as advancedChildren (not children) so it sits
              // behind ConnectPanel's "Advanced" disclosure alongside any of
              // the provider's own advanced fields, instead of always being
              // shown open -- most visitors never need to touch it.
              advancedChildren={
                !isLocal(selectedProvider) ? (
                  <EnvironmentControl
                    provider={selectedProvider}
                    env={env}
                    baseUrl={baseUrl}
                    onChange={(nextEnv, nextUrl) => {
                      patchUiState({ env: nextEnv, baseUrl: nextUrl });
                    }}
                  />
                ) : null
              }
              onResetSample={() => {
                if (
                  confirm(
                    'Restore the sample data to its starting state? Your changes to it are lost.',
                  )
                ) {
                  resetSample();
                  // The dataset just changed under any result currently on screen
                  // (bookings, availability, catalog, customers) -- clear them so
                  // a stale response is never shown as if it still reflects
                  // what's in storage.
                  setBookingResult(null);
                  setAvailResult(null);
                  setCatalogResult(null);
                  setCustomerResult(null);
                }
              }}
            >
              <PersistenceControls
                remember={remember}
                available={storageOk}
                providerLabel={PROVIDERS[selectedProvider]?.label ?? selectedProvider}
                onToggleRemember={(on) => {
                  setRemember_(on);
                  persistRemember(on); // turning off also wipes what was saved
                }}
                onClearProvider={() => {
                  clearProvider(selectedProvider);
                  // Drop this provider's edits so `creds` falls back to the
                  // entry just removed from storage, i.e. to empty.
                  setCredEdits((prev) => {
                    const next = { ...prev };
                    delete next[selectedProvider];
                    return next;
                  });
                  patchUiState({
                    env: 'prod',
                    baseUrl: ENVIRONMENTS[selectedProvider]?.prod ?? '',
                  });
                }}
                // PersistenceControls owns the confirmation now, because it
                // clears the UI state and the sample data alongside these
                // credentials: one prompt naming all three, not two prompts.
                onClearAll={() => {
                  clearAll();
                  setCredEdits({});
                  patchUiState({
                    env: 'prod',
                    baseUrl: ENVIRONMENTS[selectedProvider]?.prod ?? '',
                  });
                }}
              />
            </ConnectPanel>
          )}

          {/* ═══ CAPABILITIES TAB ═══ */}
          {activeTab === 'capabilities' && (
            <CapabilitiesTab
              selectedProvider={selectedProvider}
              capsResult={capsResult}
              setCapsResult={setCapsResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.caps}
            />
          )}

          {/* ═══ BOOKINGS TAB ═══ */}
          {activeTab === 'bookings' && (
            <BookingsTab
              selectedProvider={selectedProvider}
              conn={conn}
              defaultRange={defaultRange}
              bookingResult={bookingResult}
              setBookingResult={setBookingResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.booking}
            />
          )}

          {/* ═══ AVAILABILITY TAB ═══ */}
          {activeTab === 'availability' && (
            <AvailabilityTab
              selectedProvider={selectedProvider}
              providerInfo={providerInfo}
              conn={conn}
              defaultRange={defaultRange}
              availResult={availResult}
              setAvailResult={setAvailResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.avail}
            />
          )}

          {/* ═══ CUSTOMERS TAB ═══ */}
          {activeTab === 'customers' && (
            <CustomersTab
              selectedProvider={selectedProvider}
              providerInfo={providerInfo}
              conn={conn}
              customerResult={customerResult}
              setCustomerResult={setCustomerResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.customer}
            />
          )}

          {/* ═══ CLASSES TAB ═══ */}
          {activeTab === 'classes' && (
            <ClassesTab
              selectedProvider={selectedProvider}
              providerInfo={providerInfo}
              conn={conn}
              defaultRange={defaultRange}
              classesResult={classesResult}
              setClassesResult={setClassesResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.classes}
            />
          )}

          {/* ═══ CALENDAR SYNC TAB ═══ */}
          {activeTab === 'sync' && (
            <CalendarSyncTab
              key={selectedProvider}
              selectedProvider={selectedProvider}
              providerInfo={providerInfo}
              conn={conn}
            />
          )}

          {/* ═══ SERVICES TAB ═══ */}
          {activeTab === 'services' && (
            <ServicesTab
              key={selectedProvider}
              selectedProvider={selectedProvider}
              providerInfo={providerInfo}
              conn={conn}
              result={servicesResult}
              setResult={setServicesResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.services}
            />
          )}

          {/* ═══ MAPPING TAB ═══ */}
          {activeTab === 'mapping' && (
            <MappingTab
              key={selectedProvider}
              selectedProvider={selectedProvider}
              providerInfo={providerInfo}
              conn={conn}
              result={mappingResult}
              setResult={setMappingResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.mapping}
            />
          )}

          {/* ═══ STAFF TAB ═══ */}
          {activeTab === 'staff' && (
            <StaffTab
              key={selectedProvider}
              selectedProvider={selectedProvider}
              providerInfo={providerInfo}
              conn={conn}
              result={staffResult}
              setResult={setStaffResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.staff}
            />
          )}

          {/* ═══ UTILITIES TAB ═══ */}
          {activeTab === 'catalog' && (
            <CatalogTab
              selectedProvider={selectedProvider}
              conn={conn}
              catalogResult={catalogResult}
              setCatalogResult={setCatalogResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.catalog}
            />
          )}
          {activeTab === 'utilities' && (
            <UtilitiesTab
              selectedProvider={selectedProvider}
              conn={conn}
              defaultRange={defaultRange}
              utilResult={utilResult}
              setUtilResult={setUtilResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.util}
            />
          )}

          {/* ═══ WEBHOOKS TAB ═══ */}
          {activeTab === 'webhooks' && (
            <WebhooksTab
              webhookResult={webhookResult}
              setWebhookResult={setWebhookResult}
              wrap={wrap}
              busy={busy}
              elapsedMs={elapsedMs.webhook}
            />
          )}
        </main>
      </div>
    </div>
  );
}
