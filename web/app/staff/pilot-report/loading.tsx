import { PageShell } from '@/components/ui';
import { LoadingCard } from '@/components/states';

export default function PilotReportLoading() {
  return (
    <PageShell>
      <LoadingCard label="Building the pilot report…" />
    </PageShell>
  );
}
