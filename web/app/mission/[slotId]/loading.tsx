import { PageShell } from '@/components/ui';
import { LoadingCard } from '@/components/states';

export default function MissionLoading() {
  return (
    <PageShell>
      <LoadingCard label="Loading your mission…" />
    </PageShell>
  );
}
