import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Primitive UI building blocks. These use ONLY semantic token classes
 * (bg-surface, text-muted, rounded-lg, …) mapped in tailwind.config.ts to the
 * variables in styles/tokens.css. No raw hex/rgb/font values appear here.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-surface shadow-card ${className}`}>{children}</div>;
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    // `relative` gives absolutely-positioned descendants — above all the
    // visually-hidden .sr-only labels — a containing block INSIDE the page.
    // Without one they resolve against the initial containing block, so a label
    // inside a horizontally scrolling row (the week board's tiles) is laid out
    // at the row's full width and stretches the document: the whole page then
    // scrolled sideways at every viewport (audit #34-#37, #52).
    <main id="main-content" tabIndex={-1} className="relative mx-auto w-full max-w-content px-4 py-8">
      {children}
    </main>
  );
}

type Variant = 'primary' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:opacity-90',
  ghost: 'bg-surface-muted text-text hover:bg-border',
};

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

type Tone = 'neutral' | 'primary' | 'success' | 'danger' | 'warning' | 'locked';

/**
 * Tone = a 15% tint of the status colour (their .lof-badge pattern) with a
 * border in the full colour, and the page's own text colour on top. Their own
 * badges put the status hue ON the tint, which fails AA in at least one theme
 * for every state (danger 3.85:1 nebula, warning 2.84:1 horizon) — see
 * docs/lms-contrast-findings.md. The hue still carries the meaning through the
 * fill and border, and every badge also says what it is in words.
 */
const TONE: Record<Tone, string> = {
  neutral: 'border-border bg-surface-muted text-text-secondary',
  primary: 'border-primary bg-primary-muted text-on-tint',
  success: 'border-success bg-success-muted text-on-tint',
  danger: 'border-danger bg-danger-muted text-on-tint',
  warning: 'border-warning bg-warning-muted text-on-tint',
  locked: 'border-border bg-surface-muted text-text-secondary',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-badge ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Secondary copy — quieter than the heading, still meant to be READ, so it uses
 * their body-text colour (9.04:1 on a card), not --nebula-text-muted, which is
 * 3.82:1 in nebula and 2.54:1 in horizon.
 */
export function Muted({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-sm text-text-secondary ${className}`}>{children}</p>;
}
