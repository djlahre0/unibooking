import type { Capabilities } from 'unibooking';
import { ADAPTERS } from '../providers';
import { PROVIDER_ORDER, type GuideId } from './provider-guides';

/**
 * Human labels for every capability flag. The VALUES always come from the
 * adapters themselves (`ADAPTERS[id].capabilities`), so the docs cannot claim
 * a feature an adapter does not have. `docs-content.test.ts` checks this map
 * covers every flag the library defines.
 */
export const CAPABILITY_INFO: Record<
  keyof Capabilities,
  { label: string; description: string; methods: string }
> = {
  availability: {
    label: 'Availability search',
    description: 'Find open slots.',
    methods: 'searchAvailability',
  },
  staff: {
    label: 'Staff on bookings',
    description: 'Bookings can be assigned to a staff member.',
    methods: 'createBooking({ staffId })',
  },
  services: {
    label: 'Services on bookings',
    description: 'Bookings reference a service.',
    methods: 'createBooking({ serviceId })',
  },
  webhooks: {
    label: 'Webhook verification',
    description: 'A signature verifier ships in unibooking/webhooks.',
    methods: 'unibooking/webhooks/<id>',
  },
  idempotency: {
    label: 'Idempotent creates',
    description: 'createBooking honours idempotencyKey.',
    methods: 'createBooking({ idempotencyKey })',
  },
  customers: {
    label: 'Customer resolution',
    description: 'Find or create the provider’s customer record.',
    methods: 'customers.findOrCreate',
  },
  customerDirectory: {
    label: 'Client directory',
    description: 'Read the provider’s client records.',
    methods: 'customers.list, customers.get',
  },
  customerWrite: {
    label: 'Client writes',
    description: 'Create and update client records.',
    methods: 'customers.create, customers.update',
  },
  customerDelete: {
    label: 'Client delete',
    description: 'Delete a client record.',
    methods: 'customers.delete',
  },
  calendarList: {
    label: 'Calendar list',
    description: 'Enumerate the account’s calendars.',
    methods: 'listCalendars, getCalendar',
  },
  calendarWrite: {
    label: 'Calendar writes',
    description: 'Create, rename and delete calendars.',
    methods: 'createCalendar, updateCalendar, deleteCalendar',
  },
  serviceCatalog: {
    label: 'Service catalog',
    description: 'List the services that can be booked.',
    methods: 'listServices, getService',
  },
  staffDirectory: {
    label: 'Staff directory',
    description: 'List the staff who can be booked.',
    methods: 'listStaff, getStaff',
  },
  serviceCatalogWrite: {
    label: 'Service writes',
    description: 'Create, update and retire services.',
    methods: 'createService, updateService, setServiceActive',
  },
  staffDirectoryWrite: {
    label: 'Staff writes',
    description: 'Create and update staff.',
    methods: 'createStaff, updateStaff',
  },
  staffDeactivate: {
    label: 'Staff deactivation',
    description: 'Make a staff member unbookable without deleting them.',
    methods: 'setStaffActive',
  },
  staffDelete: {
    label: 'Staff delete',
    description: 'Remove a staff member outright.',
    methods: 'deleteStaff',
  },
  serviceDelete: {
    label: 'Service delete',
    description: 'Remove a service outright.',
    methods: 'deleteService',
  },
  staffServiceAssignment: {
    label: 'Who performs what',
    description: 'Services and staff carry each other’s ids.',
    methods: 'Service.staffIds, listStaff({ serviceId })',
  },
  staffServiceAssignmentWrite: {
    label: 'Assignment writes',
    description: 'Change who performs a service.',
    methods: 'assignStaffToService, unassignStaffFromService',
  },
  serviceCategories: {
    label: 'Service categories',
    description: 'The catalog’s own groupings.',
    methods: 'listCategories',
  },
  businessHours: {
    label: 'Business hours',
    description: 'The weekly opening hours.',
    methods: 'getBusinessHours',
  },
  classCatalog: {
    label: 'Group classes',
    description: 'Scheduled classes with capacity.',
    methods: 'listClasses, getClass',
  },
  classEnrollment: {
    label: 'Class enrolment',
    description: 'Enrol a customer into a class.',
    methods: 'enrollInClass',
  },
  classWaitlist: {
    label: 'Class waitlists',
    description: 'Join a full class’s waitlist.',
    methods: 'enrollInClass({ allowWaitlist })',
  },
  changeFeed: {
    label: 'Change sync',
    description: 'What changed since the last sync.',
    methods: 'syncBookings',
  },
  changeNotifications: {
    label: 'Change notifications',
    description: 'The provider calls your URL on changes.',
    methods: 'watchBookings, renewWatch, stopWatch',
  },
  versionedWrites: {
    label: 'Versioned writes',
    description: 'Updates can fail on a stale version instead of overwriting.',
    methods: 'updateBooking({ ifVersion })',
  },
};

export const CAPABILITY_KEYS = Object.keys(CAPABILITY_INFO) as Array<keyof Capabilities>;

export function capabilitiesOf(id: GuideId): Capabilities {
  return ADAPTERS[id]!.capabilities;
}

/** The providers that set `flag`, in docs order. */
export function providersWith(flag: keyof Capabilities): GuideId[] {
  return PROVIDER_ORDER.filter((id) => capabilitiesOf(id)[flag]);
}
