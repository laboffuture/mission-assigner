import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { serverApi } from '@/lib/api/server';
import { isEmptyWeek, normalizeSlot, type WeekPayload } from '@/lib/api/types';
import { Header } from '@/components/Header';
import { PageShell, Card, Muted } from '@/components/ui';
import { WeekBoard } from '@/components/week/WeekBoard';

/**
 * Week board — the primary daily screen. Server component: resolves identity,
 * then reads the real /api/week/:id (cookie forwarded). Locked slots arrive
 * without mission content and are rendered from metadata alone.
 */
export default async function WeekPage() {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role !== 'student') redirect('/');

  const week = await serverApi.get<WeekPayload>(`/api/week/${me.id}`);

  return (
    <>
      <Header me={me} />
      <PageShell>
        {isEmptyWeek(week) ? (
          <Card className="p-6">
            <h1 className="text-xl font-bold">No missions yet</h1>
            <Muted className="mt-2">Your week hasn’t been published. Check back soon.</Muted>
          </Card>
        ) : (
          <WeekBoard
            weekStart={week.week_start}
            dailySlots={week.slots.filter((s) => !s.is_weekly).map(normalizeSlot)}
            weeklySlot={week.slots.find((s) => s.is_weekly) ? normalizeSlot(week.slots.find((s) => s.is_weekly)!) : null}
          />
        )}
      </PageShell>
    </>
  );
}
