/**
 * Types shared by the My Calendar UI and its server routes. This module must stay
 * free of server-only imports (config, session, unibooking/oauth): the browser
 * bundle imports it.
 */

export type CalendarProvider = 'google' | 'outlook' | 'apple';
export type OAuthProvider = 'google' | 'outlook';

export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = ['google', 'outlook', 'apple'];

export function isOAuthProvider(p: unknown): p is OAuthProvider {
  return p === 'google' || p === 'outlook';
}

/** Who is connected. Whatever the provider's liveness probe surfaced. */
export interface Account {
  id?: string;
  name?: string;
  email?: string;
}

/** `GET /api/calendar/status`. Never carries a token. */
export interface CalendarStatus {
  /** False when the deployment has no usable SESSION_SECRET. */
  enabled: boolean;
  /** Why `enabled` is false, phrased for the person deploying the demo. */
  problem?: string;
  /** Which connect options this deployment offers. */
  providers: Record<CalendarProvider, boolean>;
  /** True only when THIS status request itself arrived over loopback (see
   *  `isLoopbackRequest` in lib/calendar/http.ts), never from a
   *  client-supplied header, so a remote visitor cannot make this true for
   *  themselves. Gates whether an unconfigured provider's card offers the
   *  operator's one-time OAuth app setup form, or just says the deployment
   *  hasn't set it up yet. */
  isLocalhost: boolean;
  /** `custom: true` means this connection used a visitor-supplied "bring your
   *  own OAuth app" client id/secret rather than the deployer's env-configured
   *  app: the fact only, never the id or secret itself (those never leave
   *  the sealed session cookie). */
  connection: null | { provider: CalendarProvider; account: Account; custom?: boolean };
}

export type CalendarOp =
  | 'listCalendars'
  | 'createCalendar'
  | 'updateCalendar'
  | 'deleteCalendar'
  | 'listEvents'
  | 'getEvent'
  | 'createEvent'
  | 'updateEvent'
  | 'cancelEvent'
  | 'setEventStatus'
  | 'deleteEvent';

export const CALENDAR_OPS: readonly CalendarOp[] = [
  'listCalendars',
  'createCalendar',
  'updateCalendar',
  'deleteCalendar',
  'listEvents',
  'getEvent',
  'createEvent',
  'updateEvent',
  'cancelEvent',
  'setEventStatus',
  'deleteEvent',
];

/** An event as the UI sends it. `start`/`end` are canonical instants. On update,
 *  only the fields present are changed. */
export interface EventInput {
  title?: string;
  start?: string;
  end?: string;
  timezone?: string;
  allDay?: boolean;
  description?: string;
  location?: string;
}

export const PROVIDER_LABELS: Record<CalendarProvider, string> = {
  google: 'Google Calendar',
  outlook: 'Outlook / Microsoft 365',
  apple: 'Apple iCloud',
};
