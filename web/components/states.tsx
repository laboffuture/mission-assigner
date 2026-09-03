'use client';
import type { ReactNode } from 'react';
import { Button, Card, Muted } from './ui';

/**
 * Shared, theme-token-styled loading and error states — used by every route's
 * loading.tsx / error.tsx so a student never sees an unstyled Next default or a
 * stack trace.
 */

export function Spinner() {
  return (
    <span
      className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-surface-muted border-t-primary"
      aria-hidden="true"
    />
  );
}

function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-muted ${className}`} />;
}

/** Generic skeleton card used by loading.tsx fallbacks. */
export function LoadingCard({ label = 'Loading…' }: { label?: string }) {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        <Spinner />
        <span className="text-sm text-text-muted">{label}</span>
      </div>
      <div className="mt-5 flex flex-col gap-3">
        <Bar className="h-5 w-1/3" />
        <Bar className="h-4 w-full" />
        <Bar className="h-4 w-5/6" />
        <Bar className="h-4 w-2/3" />
      </div>
    </Card>
  );
}

/** Retryable error card. `onRetry` re-runs the failed work (e.g. Next reset()). */
export function ErrorState({
  title = 'Something went wrong',
  message = 'Please try again in a moment.',
  onRetry,
  children,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <Card className="p-6 text-center">
      <h1 className="text-xl font-bold">{title}</h1>
      <Muted className="mt-2">{message}</Muted>
      {children}
      {onRetry && (
        <div className="mt-4 flex justify-center">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </Card>
  );
}
