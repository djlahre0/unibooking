/**
 * Timezone resolution shared by the iCalendar (Apple/CalDAV) and Microsoft Graph
 * adapters. Both receive local wall-clock times labelled with a zone id that may
 * be an IANA name or a Windows/Exchange zone name; this turns that into a UTC
 * offset via the platform `Intl` database, never throwing on an unknown zone.
 */

/** Windows/Exchange zone id → IANA name. Outlook/Exchange emit these instead of
 *  IANA names; anything not listed falls through to a direct `Intl` lookup. */
export const WINDOWS_TO_IANA: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Central America Standard Time': 'America/Guatemala',
  'Eastern Standard Time': 'America/New_York',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  UTC: 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Arab Standard Time': 'Asia/Riyadh',
  'Russian Standard Time': 'Europe/Moscow',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'Central Asia Standard Time': 'Asia/Almaty',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** Offset of `tz` (IANA or Windows id) at `date`, in minutes east of UTC, or
 *  `null` if the zone can't be resolved. */
export function zoneOffsetMinutes(tz: string, date: Date): number | null {
  const zone = WINDOWS_TO_IANA[tz] ?? tz;
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return (asUTC - date.getTime()) / 60_000;
}

/** A local wall-clock `2026-07-20T15:00:00` (no offset) in zone `tz` → canonical
 *  UTC instant, or `undefined` if the local string is malformed. Falls back to
 *  treating the value as UTC when the zone can't be resolved. */
export function localToInstant(isoLocal: string, tz: string, formatUTC: (epochMs: number) => string):
  | string
  | undefined {
  const guess = Date.parse(isoLocal + 'Z');
  if (Number.isNaN(guess)) return undefined;
  // Two-step correction handles the offset changing across the guessed instant.
  const offset1 = zoneOffsetMinutes(tz, new Date(guess));
  if (offset1 === null) return isoLocal + 'Z';
  const epoch1 = guess - offset1 * 60_000;
  const offset2 = zoneOffsetMinutes(tz, new Date(epoch1));
  return formatUTC(guess - (offset2 ?? offset1) * 60_000);
}
