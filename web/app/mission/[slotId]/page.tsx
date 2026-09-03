import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { serverApi } from '@/lib/api/server';
import { isEmptyWeek, normalizeSlot, type WeekPayload } from '@/lib/api/types';
import { Header } from '@/components/Header';
import { PageShell, Card, Muted, Button } from '@/components/ui';
import { MissionRunner } from '@/components/mission/MissionRunner';

/**
 * Mission view. Server component: resolves identity and looks up the slot's
 * status from the week (a GET — no mutation on render). It then dispatches:
 *   locked    → metadata-only notice (never reached from the board, defensive)
 *   submitted → already-completed notice (avoids a dead re-submit)
 *   open      → the interactive runner (client) that opens + answers the slot
 * Opening the slot (the POST that lazy-fills and awards attempt XP) happens
 * exactly once, inside the runner, on user arrival — never on every SSR pass.
 */
export default async function MissionPage({ params }: { params: { slotId: string } }) {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role !== 'student') redirect('/');

  const slotId = Number(params.slotId);
  const week = await serverApi.get<WeekPayload>(`/api/week/${me.id}`);

  const raw = isEmptyWeek(week) ? undefined : week.slots.find((s) => s.slot_id === slotId);

  return (
    <>
      <Header me={me} />
      <PageShell>
        <div className="mb-4">
          <Link href="/week" className="text-sm font-semibold text-primary hover:underline">
            ← Back to this week
          </Link>
        </div>

        {!raw ? (
          <Notice title="Mission not found" body="This mission isn’t part of your current week." />
        ) : (
          <MissionDispatch slot={normalizeSlot(raw)} slotId={slotId} />
        )}
      </PageShell>
    </>
  );
}

function MissionDispatch({ slot, slotId }: { slot: ReturnType<typeof normalizeSlot>; slotId: number }) {
  if (slot.kind === 'locked') {
    return <Notice title="Locked" body="This mission unlocks later. Come back when it opens." />;
  }
  if (slot.status === 'submitted') {
    return (
      <Notice
        title="Already completed"
        body="You’ve finished this mission. Head back to see what’s open now."
      />
    );
  }
  return <MissionRunner slotId={slotId} />;
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Card className="p-6">
      <h1 className="text-xl font-bold">{title}</h1>
      <Muted className="mt-2">{body}</Muted>
      <div className="mt-4">
        <Link href="/week">
          <Button>Back to this week</Button>
        </Link>
      </div>
    </Card>
  );
}
