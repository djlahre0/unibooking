/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionCheck, { verdictOf } from './ConnectionCheck';
import { callCheckConnection } from '../lib/call';

vi.mock('../lib/call', () => ({ callCheckConnection: vi.fn() }));
const check = vi.mocked(callCheckConnection);

beforeEach(() => check.mockReset());
afterEach(cleanup);

describe('verdictOf', () => {
  it('reports the account on success', () => {
    const v = verdictOf(
      { ok: true, data: { ok: true, account: { id: 'L1', name: 'Main St' }, raw: {} } },
      'prod',
      true,
    );
    expect(v.tone).toBe('ok');
    expect(v.detail).toBe('Signed in as Main St (id L1).');
  });

  it('a rejected token names the environment when the provider has a sandbox', () => {
    // Square's "This request could not be authorized" with a sandbox token on prod.
    const v = verdictOf(
      {
        ok: true,
        data: { ok: false, reason: 'AUTH', message: 'This request could not be authorized.' },
      },
      'prod',
      true,
    );
    expect(v.tone).toBe('bad');
    expect(v.title).toMatch(/rejected/);
    expect(v.hints?.join(' ')).toMatch(/"prod"/);
  });

  it('a thrown AUTH error reads the same as a returned one', () => {
    const v = verdictOf(
      { ok: false, error: { code: 'AUTH', message: 'bad token' } },
      'prod',
      false,
    );
    expect(v.title).toMatch(/rejected/);
    expect(v.hints?.join(' ')).not.toMatch(/sandbox/);
  });

  it('separates missing scope and wrong ids from a bad token', () => {
    expect(
      verdictOf({ ok: true, data: { ok: false, reason: 'FORBIDDEN' } }, 'prod', false).title,
    ).toMatch(/not allowed/);
    expect(
      verdictOf({ ok: true, data: { ok: false, reason: 'NOT_FOUND' } }, 'prod', false).title,
    ).toMatch(/id doesn't match/);
  });

  it('a network failure is not a verdict on the credentials', () => {
    const v = verdictOf(
      { ok: false, error: { code: 'NETWORK', message: 'fetch failed' } },
      'prod',
      false,
    );
    expect(v.tone).toBe('warn');
  });
});

describe('<ConnectionCheck>', () => {
  const props = {
    providerId: 'square',
    conn: { creds: { accessToken: 't', locationId: 'L1' } },
    missing: [],
    env: 'sandbox',
    hasSandbox: true,
  };

  it('is disabled and says what is missing', () => {
    render(<ConnectionCheck {...props} missing={['Access token']} />);
    expect(
      (screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Fill in Access token first.')).toBeDefined();
  });

  it('runs one real check and shows the verdict', async () => {
    check.mockResolvedValue({
      ok: true,
      data: { ok: true, account: { name: 'Main St' }, raw: {} },
    });
    render(<ConnectionCheck {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected/)).toBeDefined();
    expect(check).toHaveBeenCalledWith('square', props.conn);
  });

  it('drops the verdict when the credentials change', async () => {
    check.mockResolvedValue({ ok: true, data: { ok: true, raw: {} } });
    const { rerender } = render(<ConnectionCheck {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText(/Connected/);
    rerender(
      <ConnectionCheck {...props} conn={{ creds: { accessToken: 'other', locationId: 'L1' } }} />,
    );
    expect(screen.queryByText(/Connected/)).toBeNull();
  });
});
