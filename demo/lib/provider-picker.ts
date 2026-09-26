import type { Capabilities } from 'unibooking';
import { providerCapabilities } from './call';
import { PROVIDER_META } from './providers';

/**
 * How the Connect tab's picker groups providers: by what they ARE, which is
 * what a visitor choosing one is asking. (The sidebar groups by where calls
 * run, which answers a different question.)
 */
export const PICKER_GROUPS: { heading: string; blurb: string; ids: string[] }[] = [
  {
    heading: 'Try it',
    blurb: 'A sample salon kept in this browser, ready to explore.',
    ids: ['sample'],
  },
  {
    heading: 'Calendars',
    blurb: 'Personal and work calendars. Events, no staff or services.',
    ids: ['google', 'outlook', 'apple'],
  },
  {
    heading: 'Booking platforms',
    blurb: 'Salons, studios and clinics: bookings with staff, services and more.',
    ids: [
      'square',
      'acuity',
      'microsoft_bookings',
      'mindbody',
      'booker',
      'bookeo',
      'wix',
      'calendly',
      'vagaro',
      'zenoti',
      'boulevard',
      'phorest',
      'setmore',
      'mangomint',
    ],
  },
];

/** Every id in PROVIDER_META, grouped; anything not listed above lands last so
 *  a newly added provider can never vanish from the picker. */
export function pickerGroups(): { heading: string; blurb: string; ids: string[] }[] {
  const listed = new Set(PICKER_GROUPS.flatMap((g) => g.ids));
  const rest = Object.keys(PROVIDER_META).filter((id) => !listed.has(id));
  const groups = PICKER_GROUPS.map((g) => ({
    ...g,
    ids: g.ids.filter((id) => id in PROVIDER_META),
  }));
  if (rest.length) groups.push({ heading: 'Other', blurb: '', ids: rest });
  return groups;
}

/** One short line of what a provider offers, from its real capability flags. */
export function providerHint(id: string): string {
  if (id === 'mangomint') return 'Planned';
  const c = providerCapabilities(id);
  if (!c) return '';
  if (c.calendarList) return 'Events · calendars';
  const parts: string[] = ['Bookings'];
  if (c.staffDirectory || c.serviceCatalog) {
    parts.push(
      c.serviceCatalogWrite || c.staffDirectoryWrite ? 'Staff & services ✎' : 'Staff & services',
    );
  }
  if (c.classCatalog) parts.push('Classes');
  return parts.join(' · ');
}

/** Which tabs a provider can actually use. A tab not listed is always usable. */
const TAB_NEEDS: Record<string, (c: Capabilities) => boolean> = {
  availability: (c) => c.availability,
  customers: (c) => c.customers,
  classes: (c) => c.classCatalog,
  services: (c) => c.serviceCatalog,
  staff: (c) => c.staffDirectory,
  mapping: (c) => c.staffDirectory || c.serviceCatalog,
  // Your project <-> the selected calendar provider only.
  sync: (c) => c.calendarList,
  webhooks: (c) => c.webhooks,
};

/** Why a tab does nothing for this provider, or '' when it is usable. */
export function tabUnsupported(tab: string, providerId: string): string {
  const need = TAB_NEEDS[tab];
  const c = providerId ? providerCapabilities(providerId) : null;
  if (!need || !c || need(c)) return '';
  const label = PROVIDER_META[providerId]?.label ?? providerId;
  return `${label} doesn't support this`;
}
