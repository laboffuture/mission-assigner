'use client';
import { useId } from 'react';

/**
 * Accessible single-choice control built on NATIVE radio inputs — so keyboard
 * navigation (arrow keys move within the group, Tab moves past it), focus
 * management and screen-reader semantics all come from the platform rather than
 * being re-implemented. The visible pill is styled; the real radio is
 * screen-reader-only but still focusable, and the visible pill shows a focus ring
 * (peer-focus-visible) and a non-colour "✓" when selected so selection is never
 * signalled by colour alone.
 */
export interface RadioOption {
  value: string;
  /** Visible label. */
  label: string;
  /** Optional richer accessible name (defaults to `label`). */
  ariaLabel?: string;
}

export function RadioGroup({
  name,
  legendId,
  options,
  value,
  onChange,
  disabled,
  startCaption,
  endCaption,
}: {
  name: string;
  /** id of the element that labels this group (aria-labelledby). */
  legendId: string;
  options: RadioOption[];
  value: string | undefined;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Optional scale endpoint captions, e.g. "Low" / "High". */
  startCaption?: string;
  endCaption?: string;
}) {
  const gid = useId();
  return (
    <div className="flex items-center gap-2">
      {startCaption && <span className="text-xs text-text-muted">{startCaption}</span>}
      <div role="radiogroup" aria-labelledby={legendId} className="flex flex-wrap items-center gap-2">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <label key={opt.value} htmlFor={`${gid}-${opt.value}`} className="cursor-pointer">
              <input
                id={`${gid}-${opt.value}`}
                type="radio"
                name={name}
                value={opt.value}
                checked={active}
                disabled={disabled}
                onChange={() => onChange(opt.value)}
                aria-label={opt.ariaLabel ?? opt.label}
                className="peer sr-only"
              />
              {/* Visible pill (input precedes it, so peer-focus-visible works). The
                  "✓" gives selection a non-colour signal. */}
              <span
                className={`inline-flex select-none items-center gap-1 rounded-full border px-4 py-1.5 text-sm font-medium transition peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-2 ${
                  active
                    ? 'border-primary bg-primary text-primary-fg'
                    : 'border-border bg-surface text-text hover:border-primary'
                } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <span aria-hidden="true">{active ? '✓' : ''}</span>
                <span aria-hidden={opt.ariaLabel ? true : undefined}>{opt.label}</span>
              </span>
            </label>
          );
        })}
      </div>
      {endCaption && <span className="text-xs text-text-muted">{endCaption}</span>}
    </div>
  );
}
