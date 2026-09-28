'use client';

import { useId, useMemo } from 'react';

/** Every IANA zone the runtime knows, for type-to-search via <datalist>. */
function allZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

export default function TimezoneField({
  label,
  value,
  onChange,
  name,
}: {
  label: string;
  value: string;
  onChange: (tz: string) => void;
  name?: string;
}) {
  const listId = useId();
  const inputId = useId();
  const zones = useMemo(() => allZones(), []);
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        className="form-input"
        list={listId}
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder="e.g. Asia/Kolkata"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </div>
  );
}
