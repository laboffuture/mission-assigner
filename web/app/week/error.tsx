'use client';
import { PageShell } from '@/components/ui';
import { ErrorState } from '@/components/states';

export default function WeekError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState title="Couldn’t load your week" message="We couldn’t reach your missions just now." onRetry={reset} />
    </PageShell>
  );
}
