'use client';
import { PageShell } from '@/components/ui';
import { ErrorState } from '@/components/states';

export default function FeedbackError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState title="Couldn’t load the feedback form" message="Please try again." onRetry={reset} />
    </PageShell>
  );
}
