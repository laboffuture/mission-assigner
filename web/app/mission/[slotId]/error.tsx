'use client';
import { PageShell } from '@/components/ui';
import { ErrorState } from '@/components/states';

export default function MissionError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState title="Couldn’t load this mission" message="Something went wrong opening it." onRetry={reset} />
    </PageShell>
  );
}
