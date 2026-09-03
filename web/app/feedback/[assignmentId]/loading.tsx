import { PageShell } from '@/components/ui';
import { LoadingCard } from '@/components/states';

export default function FeedbackLoading() {
  return (
    <PageShell>
      <LoadingCard label="Loading feedback…" />
    </PageShell>
  );
}
