import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { serverApi } from '@/lib/api/server';
import type { Page, Progress, Segment, SubmissionRow } from '@/lib/api/types';
import { Header } from '@/components/Header';
import { PageShell } from '@/components/ui';
import { Hero } from '@/components/progress/Hero';
import { PlacementCard } from '@/components/progress/PlacementCard';
import { SubmissionLog } from '@/components/progress/SubmissionLog';

/**
 * Progress panel. Leads with the motivating numbers (level + streak), then XP,
 * then the plain-language placement, then the paginated submission log. Reads
 * only student-facing data — no stall_count, no assistance events, no leaderboard.
 */
export default async function ProgressPage() {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role !== 'student') redirect('/');

  const [progress, segment, firstPage] = await Promise.all([
    serverApi.get<Progress>(`/api/progress/${me.id}`),
    serverApi.get<Segment>(`/api/segment/${me.id}`),
    serverApi.get<Page<SubmissionRow>>(`/api/submissions/${me.id}`),
  ]);

  return (
    <>
      <Header me={me} />
      <PageShell>
        <div className="flex flex-col gap-6">
          <Hero progress={progress} />
          <PlacementCard segment={segment} />
          <section>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-text-muted">Recent missions</h2>
            <SubmissionLog
              studentId={me.id}
              initialItems={firstPage.items}
              initialCursor={firstPage.nextCursor ?? null}
            />
          </section>
        </div>
      </PageShell>
    </>
  );
}
