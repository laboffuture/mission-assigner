'use client';
import { PageShell } from '@/components/ui';
import { ErrorState } from '@/components/states';

export default function ProgressError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState title="Couldn’t load your progress" message="Please try again." onRetry={reset} />
    </PageShell>
  );
}
