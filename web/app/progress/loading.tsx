import { PageShell } from '@/components/ui';
import { LoadingCard } from '@/components/states';

export default function ProgressLoading() {
  return (
    <PageShell>
      <LoadingCard label="Loading your progress…" />
    </PageShell>
  );
}
