import { PageShell } from '@/components/ui';
import { LoadingCard } from '@/components/states';

export default function WeekLoading() {
  return (
    <PageShell>
      <LoadingCard label="Loading your week…" />
    </PageShell>
  );
}
