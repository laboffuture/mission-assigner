import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { serverApi } from '@/lib/api/server';
import type { PilotReport } from '@/lib/api/types';
import { PageNav } from '@/components/PageNav';
import { PageShell } from '@/components/ui';
import { AccessDenied } from '@/components/staff/AccessDenied';
import { PilotReportView } from '@/components/staff/PilotReportView';

/**
 * The weekly pilot report (audit item 15). Staff-only — every staff role, since
 * the SME, management and instructors all read it — and refused to students, who
 * are what it is about.
 *
 * The download link points at the API's own `?format=html` document rather than
 * re-rendering the page: what gets emailed is then the report the server built,
 * not a second version of it assembled here. Same origin either way (Next
 * rewrites /api/* locally, Caddy routes it in the deployed stack), so the session
 * cookie travels with the download.
 */
export default async function PilotReportPage() {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role === 'student') return <AccessDenied me={me} />;

  const report = await serverApi.get<PilotReport>('/api/pilot-report');

  return (
    <PageShell>
      <PageNav me={me} current="report" />
      <PilotReportView report={report} downloadHref="/api/pilot-report?format=html" />
    </PageShell>
  );
}
