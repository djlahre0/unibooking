'use client';

import { useEffect, useRef, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { loadUiState, patchUiState } from '../lib/ui-state';

/**
 * Never serialized and never restored into. Filtering by control TYPE rather
 * than by field name is deliberate: a name blocklist starts leaking the day
 * someone adds a field it does not know about, and the webhook tab's HMAC
 * fields are exactly that risk. `file` cannot be restored anyway, and the
 * button types carry no user input.
 */
const SKIP = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image']);

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isControl(el: unknown): el is Control {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  );
}

function skipped(el: Control): boolean {
  return el instanceof HTMLInputElement && SKIP.has(el.type);
}

function collect(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(form.elements)) {
    if (!isControl(el) || !el.name || skipped(el)) continue;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.checked) out[el.name] = el.value;
      continue;
    }
    if (el.value !== '') out[el.name] = el.value;
  }
  return out;
}

export type PersistedFormProps = {
  /** "<tab>:<op>": a tab may hold several mutually exclusive forms. */
  formKey: string;
  children: ReactNode;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  className?: string;
  style?: CSSProperties;
};

/**
 * Wraps a `<form>` so what the visitor typed survives a reload, without
 * turning any input into a controlled component. Values are restored in an
 * effect AFTER mount, so the server HTML and the hydration pass always agree.
 *
 * Submit handlers keep working unchanged: this renders a real `<form>`, so
 * `new FormData(e.currentTarget)` still sees every field, including the
 * password ones this never writes to storage.
 */
export default function PersistedForm({
  formKey,
  children,
  onSubmit,
  className,
  style,
}: PersistedFormProps) {
  const ref = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    const saved = loadUiState().forms[formKey];
    if (!saved) return;
    for (const [name, value] of Object.entries(saved)) {
      const el = form.elements.namedItem(name);
      if (!isControl(el) || skipped(el)) continue;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        el.checked = el.value === value;
        continue;
      }
      el.value = value;
    }
  }, [formKey]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Debounced like cred-storage's save effect, so typing does not write on
  // every keystroke. `input` is delegated from the form, so inputs rendered
  // later (a conditionally shown field) are covered without re-binding.
  const save = () => {
    const form = ref.current;
    if (!form) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const current = loadUiState();
      patchUiState({ forms: { ...current.forms, [formKey]: collect(form) } });
    }, 300);
  };

  return (
    <form
      ref={ref}
      className={className}
      style={style}
      onSubmit={onSubmit}
      onInput={save}
      onChange={save}
    >
      {children}
    </form>
  );
}
