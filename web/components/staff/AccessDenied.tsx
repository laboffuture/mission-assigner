import type { Me } from '@/lib/api/types';
import { PageNav } from '@/components/PageNav';
import { PageShell, Card, Muted } from '@/components/ui';

/** Shown to a signed-in user whose role may not see a staff screen. */
export function AccessDenied({ me }: { me: Me }) {
  return (
    <>
      <PageShell>
        <PageNav me={me} />
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
