import { describe, expect, it } from 'vitest';
import type { BookingClient } from '../../src/types';

import { acuity } from '../../src/adapters/acuity';
import { apple } from '../../src/adapters/apple';
import { bookeo } from '../../src/adapters/bookeo';
import { booker } from '../../src/adapters/booker';
import { boulevard } from '../../src/adapters/boulevard';
import { calendly } from '../../src/adapters/calendly';
import { google } from '../../src/adapters/google';
import { mangomint } from '../../src/adapters/mangomint';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { mindbody } from '../../src/adapters/mindbody';
import { outlook } from '../../src/adapters/outlook';
import { phorest } from '../../src/adapters/phorest';
import { setmore } from '../../src/adapters/setmore';
import { square } from '../../src/adapters/square';
import { vagaro } from '../../src/adapters/vagaro';
import { wix } from '../../src/adapters/wix';
import { zenoti } from '../../src/adapters/zenoti';

/** Every shipped adapter, with credentials good enough to construct a client.
 *  No request is made here — this is a pure shape check. */
const CLIENTS: Array<[string, () => BookingClient]> = [
  ['acuity', () => acuity({ userId: 'u', apiKey: 'k' })],
  ['apple', () => apple({ username: 'u', appPassword: 'p' })],
  ['bookeo', () => bookeo({ apiKey: 'k', secretKey: 's' })],
  ['booker', () => booker({ accessToken: 't', subscriptionKey: 's', locationId: 'L1' })],
  ['boulevard', () => boulevard({ businessId: 'b', locationId: 'l', apiKey: 'k', apiSecret: 's' })],
  ['calendly', () => calendly({ token: 't' })],
  ['google', () => google({ accessToken: 't' })],
  ['mangomint', () => mangomint({} as never)],
  ['microsoft_bookings', () => microsoftBookings({ accessToken: 't', businessId: 'b' })],
  ['mindbody', () => mindbody({ apiKey: 'k', siteId: '-99', accessToken: 't' })],
  ['outlook', () => outlook({ accessToken: 't' })],
  ['phorest', () => phorest({ username: 'u', password: 'p', businessId: 'b', branchId: 'br' })],
  ['setmore', () => setmore({ accessToken: 't' })],
  ['square', () => square({ accessToken: 't', locationId: 'l' })],
  ['vagaro', () => vagaro({ region: 'us04', accessToken: 't', businessId: 'b' })],
  ['wix', () => wix({ accessToken: 't' })],
  ['zenoti', () => zenoti({ apiKey: 'k', centerId: 'c' })],
];

/** Adapters that genuinely implement group classes. Everything else must both
 *  declare the flags false AND omit the methods — a capability flag that lies
 *  is worse than no support, because callers branch on it. */
const CLASS_PROVIDERS = ['mindbody', 'acuity', 'booker'];
/** Adapters implementing the staff<->service link and catalog categories. */
const ASSIGNMENT_PROVIDERS = ['square', 'acuity', 'booker'];
/** Adapters exposing recurring weekly opening hours. */
const HOURS_PROVIDERS = ['square', 'booker'];

describe('class capability flags are honest', () => {
  for (const [name, make] of CLIENTS) {
    const supports = CLASS_PROVIDERS.includes(name);

    it(`${name}: flags and methods agree (${supports ? 'supported' : 'unsupported'})`, () => {
      const client = make();
      const caps = client.capabilities;

      expect(typeof caps.classCatalog).toBe('boolean');
      expect(typeof caps.classEnrollment).toBe('boolean');
      expect(typeof caps.classWaitlist).toBe('boolean');
      expect(caps.classCatalog).toBe(supports);

      // A method must be present exactly when its flag says so. Either half
      // alone lets a caller take a branch that then dies on an undefined call.
      expect(typeof client.listClasses === 'function').toBe(caps.classCatalog);
      expect(typeof client.getClass === 'function').toBe(caps.classCatalog);
      expect(typeof client.enrollInClass === 'function').toBe(caps.classEnrollment);

      // A waitlist is meaningless without enrollment, and enrollment is
      // meaningless without a catalog to enroll into.
      if (caps.classWaitlist) expect(caps.classEnrollment).toBe(true);
      if (caps.classEnrollment) expect(caps.classCatalog).toBe(true);

      // Categories and business hours follow the same flag/method contract.
      expect(caps.serviceCategories).toBe(ASSIGNMENT_PROVIDERS.includes(name));
      expect(typeof client.listCategories === 'function').toBe(caps.serviceCategories);
      expect(caps.businessHours).toBe(HOURS_PROVIDERS.includes(name));
      expect(typeof client.getBusinessHours === 'function').toBe(caps.businessHours);

      // The assignment flag has no method of its own -- it promises fields on
      // Service/Staff -- but it is meaningless without a catalog to carry them.
      expect(caps.staffServiceAssignment).toBe(ASSIGNMENT_PROVIDERS.includes(name));
      if (caps.staffServiceAssignment) expect(caps.serviceCatalog).toBe(true);
    });
  }

  it('exactly the declared providers support classes', () => {
    const supporting = CLIENTS.filter(([, make]) => make().capabilities.classCatalog)
      .map(([name]) => name)
      .sort();
    expect(supporting).toEqual([...CLASS_PROVIDERS].sort());
  });

  it('mindbody declares a waitlist and acuity does not', () => {
    // Acuity has no class waitlist at all, so claiming one would make
    // `allowWaitlist` look usable when it can only ever produce a CONFLICT.
    expect(
      mindbody({ apiKey: 'k', siteId: '-99', accessToken: 't' }).capabilities.classWaitlist,
    ).toBe(true);
    expect(acuity({ userId: 'u', apiKey: 'k' }).capabilities.classWaitlist).toBe(false);
  });
});
