/**
 * The Explorer's sections, in sidebar order. One list feeds the sidebar, the
 * heading above each section, and the site search, so the three can never
 * disagree about what a section is called or where its docs live.
 */
export type ExplorerGroup = 'Start' | 'Work' | 'Tools';

export type ExplorerSection = {
  id: string;
  label: string;
  group: ExplorerGroup;
  /** One line under the section heading. */
  description: string;
  /** The docs page that explains what this section exercises. */
  doc: string;
};

export const EXPLORER_GROUPS: ExplorerGroup[] = ['Start', 'Work', 'Tools'];

export const EXPLORER_SECTIONS: ExplorerSection[] = [
  {
    id: 'calendar',
    label: 'My Calendar',
    group: 'Start',
    description: 'Sign in with Google, Microsoft or iCloud and work with your own calendar.',
    doc: '/docs/guides/explorer',
  },
  {
    id: 'connect',
    label: 'Connect',
    group: 'Start',
    description: 'Pick a provider, paste its credentials and test the connection.',
    doc: '/docs/guides/connecting',
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    group: 'Start',
    description: 'What the selected provider can and cannot do, straight from its adapter.',
    doc: '/docs/concepts/capabilities',
  },
  {
    id: 'bookings',
    label: 'Bookings',
    group: 'Work',
    description: 'Create, read, reschedule, cancel and list bookings.',
    doc: '/docs/reference/client',
  },
  {
    id: 'availability',
    label: 'Availability',
    group: 'Work',
    description: 'Search open slots for a service, a staff member or a calendar.',
    doc: '/docs/reference/client',
  },
  {
    id: 'customers',
    label: 'Clients',
    group: 'Work',
    description: 'Find, create and update the provider’s client records.',
    doc: '/docs/reference/client',
  },
  {
    id: 'classes',
    label: 'Classes',
    group: 'Work',
    description: 'Group classes: capacity, waitlists and enrolment.',
    doc: '/docs/reference/client',
  },
  {
    id: 'services',
    label: 'Services',
    group: 'Work',
    description: 'The service catalog, and who performs what.',
    doc: '/docs/reference/client',
  },
  {
    id: 'staff',
    label: 'Staff',
    group: 'Work',
    description: 'The staff directory: list, create, update and deactivate.',
    doc: '/docs/reference/client',
  },
  {
    id: 'mapping',
    label: 'Mapping',
    group: 'Work',
    description: 'Link your own records to the provider’s, without merging them.',
    doc: '/docs/guides/multi-tenant',
  },
  {
    id: 'sync',
    label: 'Calendar Sync',
    group: 'Work',
    description: 'Mirror staff and service bookings into a connected calendar.',
    doc: '/docs/guides/webhooks',
  },
  {
    id: 'catalog',
    label: 'Catalog & Health',
    group: 'Tools',
    description: 'Registry lookups and connection health across providers.',
    doc: '/docs/reference/capabilities',
  },
  {
    id: 'utilities',
    label: 'Utilities',
    group: 'Tools',
    description: 'withRetry, listAll and collectAll against the selected provider.',
    doc: '/docs/guides/retries',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    group: 'Tools',
    description: 'Verify webhook signatures exactly as your server would.',
    doc: '/docs/guides/webhooks',
  },
];

export function sectionById(id: string): ExplorerSection | undefined {
  return EXPLORER_SECTIONS.find((s) => s.id === id);
}
