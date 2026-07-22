/**
 * Timezone resolution shared by the iCalendar (Apple/CalDAV) and Microsoft Graph
 * adapters. Both receive local wall-clock times labelled with a zone id that may
 * be an IANA name or a Windows/Exchange zone name; this turns that into a UTC
 * offset via the platform `Intl` database, never throwing on an unknown zone.
 */

/** Windows/Exchange zone id → IANA name. Outlook/Exchange emit these instead of
 *  IANA names; anything not listed falls through to a direct `Intl` lookup, then
 *  to the `(UTC±HH:MM)` prefix of a Windows display name. */
const WINDOWS_TO_IANA: Record<string, string> = {
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
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Myanmar Standard Time': 'Asia/Yangon',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Egypt Standard Time': 'Africa/Cairo',
  'Morocco Standard Time': 'Africa/Casablanca',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Taipei Standard Time': 'Asia/Taipei',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Samoa Standard Time': 'Pacific/Apia',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'SA Eastern Standard Time': 'America/Cayenne',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Montevideo Standard Time': 'America/Montevideo',
  'Venezuela Standard Time': 'America/Caracas',
  'Paraguay Standard Time': 'America/Asuncion',
  'Bahia Standard Time': 'America/Bahia',
  'Mid-Atlantic Standard Time': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'Belarus Standard Time': 'Europe/Minsk',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Russia Time Zone 3': 'Europe/Samara',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Omsk Standard Time': 'Asia/Omsk',
  'Altai Standard Time': 'Asia/Barnaul',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Jordan Standard Time': 'Asia/Amman',
  'Middle East Standard Time': 'Asia/Beirut',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'Aleutian Standard Time': 'America/Adak',
  'Yukon Standard Time': 'America/Whitehorse',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Saratov Standard Time': 'Europe/Saratov',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Magadan Standard Time': 'Asia/Magadan',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Tocantins Standard Time': 'America/Araguaina',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'West Asia Standard Time': 'Asia/Tashkent',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'UTC-02': 'Etc/GMT+2',
  'UTC-08': 'Etc/GMT+8',
  'UTC-09': 'Etc/GMT+9',
  'UTC+12': 'Etc/GMT-12',
  'UTC+13': 'Etc/GMT-13',
};

/** Windows *display* names — `"(UTC-08:00) Pacific Time (US & Canada)"` — carry
 *  their standard offset in the prefix. Microsoft Bookings emits this format
 *  (e.g. getStaffAvailability), and it resolves via neither the id map nor
 *  `Intl`. The prefix is the zone's standard offset, so during DST it can be an
 *  hour off — still far better than the treat-as-UTC fallback (hours off). */
function displayNameOffsetMinutes(tz: string): number | null {
  const m = /^\((?:UTC|GMT)(?:([+-])(\d{2}):(\d{2}))?\)/.exec(tz);
  if (!m) return null;
  if (!m[1]) return 0; // "(UTC) Coordinated Universal Time"
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

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
    return displayNameOffsetMinutes(tz);
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
