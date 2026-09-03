import type { Me } from '@/lib/api/types';
import { Header } from '@/components/Header';
import { PageShell, Card, Muted } from '@/components/ui';

/** Shown to a signed-in user whose role may not see a staff screen. */
export function AccessDenied({ me }: { me: Me }) {
  return (
    <>
      <Header me={me} />
      <PageShell>
        <Card className="p-6">
          <h1 className="text-xl font-bold">Not available for your role</h1>
          <Muted className="mt-2">
            This is an instructor tool. You’re signed in as <strong>{me.role}</strong>.
          </Muted>
        </Card>
      </PageShell>
    </>
  );
}
