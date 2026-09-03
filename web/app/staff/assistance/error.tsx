'use client';
import { PageShell } from '@/components/ui';
import { ErrorState } from '@/components/states';

export default function AssistanceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState title="Couldn’t load the assistance queue" message="Please try again." onRetry={reset} />
    </PageShell>
  );
}
