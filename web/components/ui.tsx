import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Primitive UI building blocks. These use ONLY semantic token classes
 * (bg-surface, text-muted, rounded-lg, …) mapped in tailwind.config.ts to the
 * variables in styles/tokens.css. No raw hex/rgb/font values appear here.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface shadow-card ${className}`}>{children}</div>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-content px-4 py-8">
      {children}
    </main>
  );
}

type Variant = 'primary' | 'ghost' | 'danger';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:opacity-90',
  ghost: 'bg-surface-muted text-text hover:bg-border',
  danger: 'bg-danger text-danger-fg hover:opacity-90',
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

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-text-muted',
  primary: 'bg-primary-muted text-primary',
  success: 'bg-success-muted text-success',
  danger: 'bg-danger-muted text-danger',
  warning: 'bg-warning-muted text-warning',
  locked: 'bg-surface-muted text-locked',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Muted({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-sm text-text-muted ${className}`}>{children}</p>;
}
