import { PageShell } from '@/components/ui';
import { LoadingCard } from '@/components/states';

export default function AssistanceLoading() {
  return (
    <PageShell>
      <LoadingCard label="Loading the assistance queue…" />
    </PageShell>
  );
}
