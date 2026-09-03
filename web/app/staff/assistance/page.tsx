import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { serverApi } from '@/lib/api/server';
import type { AssistanceListItem, Page } from '@/lib/api/types';
import { Header } from '@/components/Header';
import { PageShell, Muted } from '@/components/ui';
import { AccessDenied } from '@/components/staff/AccessDenied';
import { AssistanceQueue } from '@/components/staff/AssistanceQueue';

/**
 * Instructor assistance queue. Staff-only (instructor/admin). Reads identity via
 * /api/me (same session pattern as the student pages) and the first page of open
 * events (oldest first — the longest-waiting student is most urgent).
 */
export default async function AssistancePage() {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role !== 'instructor' && me.role !== 'admin') return <AccessDenied me={me} />;

  const first = await serverApi.get<Page<AssistanceListItem>>('/api/assistance');

  return (
    <>
      <Header me={me} />
      <PageShell>
        <div className="mb-4">
          <h1 className="text-xl font-bold">Assistance queue</h1>
          <Muted className="mt-1">Students who stalled and need a hand. Oldest first.</Muted>
        </div>
        <AssistanceQueue initialItems={first.items} initialCursor={first.nextCursor ?? null} />
      </PageShell>
    </>
  );
}
