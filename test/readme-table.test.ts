import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Capabilities, ProviderId } from '../src/types';

import { google } from '../src/adapters/google';
import { outlook } from '../src/adapters/outlook';
import { microsoftBookings } from '../src/adapters/microsoft_bookings';
import { square } from '../src/adapters/square';
import { calendly } from '../src/adapters/calendly';
import { wix } from '../src/adapters/wix';
import { acuity } from '../src/adapters/acuity';
import { bookeo } from '../src/adapters/bookeo';
import { mindbody } from '../src/adapters/mindbody';
import { setmore } from '../src/adapters/setmore';
import { vagaro } from '../src/adapters/vagaro';
import { phorest } from '../src/adapters/phorest';
import { zenoti } from '../src/adapters/zenoti';
import { apple } from '../src/adapters/apple';
import { boulevard } from '../src/adapters/boulevard';

/**
 * The README's Supported Providers table is the first thing an adopter reads, and
 * it silently drifted from the adapters twice before this test existed. Rather
 * than re-checking it by hand, assert it against the real `capabilities` objects.
 *
 * Only the five capability columns are machine-checkable — Read/Create/Update/
 * Cancel describe method behaviour, not a flag, so those stay a human call.
 */

const README = readFileSync(resolve(__dirname, '../README.md'), 'utf8');

/** Table row label -> the adapter whose flags it must match. */
const ROWS: Array<[string, { id: ProviderId; capabilities: Capabilities }]> = [
  ['Google Calendar', google],
  ['Outlook / Microsoft 365', outlook],
  ['Microsoft Bookings', microsoftBookings],
  ['Square', square],
  ['Calendly', calendly],
  ['Wix Bookings', wix],
  ['Acuity', acuity],
  ['Bookeo', bookeo],
  ['Mindbody', mindbody],
  ['Setmore', setmore],
  ['Vagaro', vagaro],
  ['Phorest', phorest],
  ['Zenoti', zenoti],
  ['Apple CalDAV', apple],
  ['Boulevard', boulevard],
];

// | Provider | Read | Create | Update | Cancel | Availability | Customers | Staff | Services | Webhooks |
const COLUMNS: Array<[keyof Capabilities, number]> = [
  ['availability', 4],
  ['customers', 5],
  ['staff', 6],
  ['services', 7],
  ['webhooks', 8],
];

const YES = '✅';
const PARTIAL = '⚠️';
const NO = '—';

function tableCells(label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const row = new RegExp(`^\\|\\s*\\[${escaped}\\]\\([^)]+\\)\\s*\\|(.+)\\|\\s*$`, 'm').exec(README);
  if (!row) throw new Error(`no linked table row for "${label}"`);
  return row[1]!.split('|').map((c) => c.trim());
}

describe('README provider table matches the adapters', () => {
  it.each(ROWS)('%s capability columns are accurate', (label, adapter) => {
    const cells = tableCells(label);
    for (const [key, idx] of COLUMNS) {
      const cell = cells[idx];
      expect(cell, `${label}.${key}: missing cell`).toBeDefined();
      expect([YES, PARTIAL, NO], `${label}.${key}: unexpected marker ${cell}`).toContain(cell);
      // ⚠️ means supported with caveats — still a supported capability.
      const claimed = cell === YES || cell === PARTIAL;
      expect(claimed, `${label}.${key}: table says ${cell}, adapter says ${adapter.capabilities[key]}`).toBe(
        adapter.capabilities[key],
      );
    }
  });

  it('links every shipped provider except the unimplemented stub', () => {
    for (const [label] of ROWS) expect(() => tableCells(label)).not.toThrow();
    // MangoMint publishes no public API reference, so it is intentionally
    // unlinked — but it must still appear, flagged as planned.
    expect(README).toMatch(/\|\s*MangoMint\s*\|\s*🚧 Planned/);
  });

  it('points every provider link at an https docs URL', () => {
    for (const [label] of ROWS) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const link = new RegExp(`^\\|\\s*\\[${escaped}\\]\\((https://[^)]+)\\)`, 'm').exec(README);
      expect(link, `${label}: provider name is not a link`).toBeTruthy();
    }
  });
});
