/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FormEvent } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PersistedForm from './PersistedForm';
import { loadUiState, patchUiState, UI_KEY, __resetUiState } from '../lib/ui-state';

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

function Form() {
  return (
    <PersistedForm formKey="bookings:create">
      <input name="title" aria-label="Title" />
      <input name="secret" type="password" aria-label="Secret" />
      <textarea name="notes" aria-label="Notes" />
      <select name="mode" aria-label="Mode">
        <option value="a">a</option>
        <option value="b">b</option>
      </select>
    </PersistedForm>
  );
}

describe('PersistedForm', () => {
  it('saves typed values under its form key', async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.type(screen.getByLabelText('Title'), 'Haircut');
    await vi.waitFor(() => {
      expect(loadUiState().forms['bookings:create']?.title).toBe('Haircut');
    }, { timeout: 4000 });
  });

  it('NEVER saves a password field', async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.type(screen.getByLabelText('Title'), 'ok');
    await user.type(screen.getByLabelText('Secret'), 'hunter2');
    await vi.waitFor(() => {
      expect(loadUiState().forms['bookings:create']?.title).toBe('ok');
    }, { timeout: 4000 });
    const saved = loadUiState().forms['bookings:create'] ?? {};
    expect(saved.secret).toBeUndefined();
    expect(localStorage.getItem(UI_KEY) ?? '').not.toContain('hunter2');
  });

  it('restores saved values on mount', () => {
    patchUiState({ forms: { 'bookings:create': { title: 'Restored', mode: 'b', notes: 'hi' } } });
    render(<Form />);
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('Restored');
    expect(screen.getByLabelText<HTMLSelectElement>('Mode').value).toBe('b');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Notes').value).toBe('hi');
  });

  it('refuses to restore INTO a password field even if one is somehow stored', () => {
    // Defense in depth: a hand-edited localStorage must not be able to
    // pre-fill a secret box and have it submitted by an unsuspecting visitor.
    patchUiState({ forms: { 'bookings:create': { secret: 'planted' } } });
    render(<Form />);
    expect(screen.getByLabelText<HTMLInputElement>('Secret').value).toBe('');
  });

  it('keeps separate keys separate', async () => {
    const user = userEvent.setup();
    render(
      <>
        <PersistedForm formKey="a:one">
          <input name="title" aria-label="One" />
        </PersistedForm>
        <PersistedForm formKey="b:two">
          <input name="title" aria-label="Two" />
        </PersistedForm>
      </>,
    );
    await user.type(screen.getByLabelText('One'), 'first');
    await user.type(screen.getByLabelText('Two'), 'second');
    await vi.waitFor(() => {
      expect(loadUiState().forms['b:two']?.title).toBe('second');
    }, { timeout: 4000 });
    expect(loadUiState().forms['a:one']?.title).toBe('first');
  });

  it('still submits through the onSubmit it was given', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: FormEvent<HTMLFormElement>) => e.preventDefault());
    render(
      <PersistedForm formKey="x:y" onSubmit={onSubmit}>
        <input name="title" aria-label="Title" />
        <button type="submit">Go</button>
      </PersistedForm>,
    );
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a submit handler still reads values through FormData, as the tabs do', async () => {
    const user = userEvent.setup();
    const seen: Record<string, string> = {};
    render(
      <PersistedForm
        formKey="x:z"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          seen.title = fd.get('title') as string;
          seen.secret = fd.get('secret') as string;
        }}
      >
        <input name="title" aria-label="Title" />
        <input name="secret" type="password" aria-label="Secret" />
        <button type="submit">Go</button>
      </PersistedForm>,
    );
    await user.type(screen.getByLabelText('Title'), 'Trim');
    await user.type(screen.getByLabelText('Secret'), 'live-secret');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    // The password still reaches the handler — it is only never PERSISTED.
    expect(seen.title).toBe('Trim');
    expect(seen.secret).toBe('live-secret');
  });
});
