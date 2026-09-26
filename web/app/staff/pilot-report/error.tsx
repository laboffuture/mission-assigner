'use client';
import { PageShell } from '@/components/ui';
import { ErrorState } from '@/components/states';

export default function PilotReportError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState title="Couldn’t build the pilot report" message="Please try again." onRetry={reset} />
    </PageShell>
  );
}
