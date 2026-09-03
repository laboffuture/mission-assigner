'use client';
import { PageShell } from '@/components/ui';
import { ErrorState } from '@/components/states';

export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <ErrorState onRetry={reset} />
    </PageShell>
  );
}
