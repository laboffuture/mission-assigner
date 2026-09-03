import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { serverApi } from '@/lib/api/server';
import { ApiError } from '@/lib/api/error';
import type { AssistanceDetail, AssistanceFailedMission } from '@/lib/api/types';
import { Header } from '@/components/Header';
import { PageShell, Card, Badge, Muted } from '@/components/ui';
import { AccessDenied } from '@/components/staff/AccessDenied';
import { AssistanceActions } from '@/components/staff/AssistanceActions';
import { formatWaiting, formatDateTime } from '@/lib/time';

function FailedMission({ m }: { m: AssistanceFailedMission }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-bold">{m.title}</h3>
        {m.tags.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-1">
            {m.tags.map((t) => (
              <Badge key={t} tone="neutral">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 text-sm leading-relaxed">{m.body}</p>

      <ul className="mt-3 flex flex-col gap-1.5">
        {m.options.map((o) => {
          const isCorrect = o.option_key === m.correct_key;
          const isChosen = o.option_key === m.selected_key;
          const tone = isCorrect
            ? 'border-success bg-success-muted'
            : isChosen
              ? 'border-danger bg-danger-muted'
              : 'border-border bg-surface';
          return (
            <li key={o.option_key} className={`flex items-center justify-between gap-3 rounded border px-3 py-1.5 text-sm ${tone}`}>
              <span>
                <span aria-hidden="true" className="mr-1 font-bold">
                  {isCorrect ? '✓' : isChosen ? '✗' : ' '}
                </span>
                <span className="font-semibold uppercase">{o.option_key}.</span> {o.option_text}
              </span>
              <span className="flex shrink-0 gap-1">
                {isCorrect && <Badge tone="success">Correct</Badge>}
                {isChosen && !isCorrect && <Badge tone="danger">Their answer</Badge>}
              </span>
            </li>
          );
        })}
      </ul>

      {m.explanation && (
        <p className="mt-3 border-l-4 border-l-primary bg-surface-muted px-3 py-2 text-sm">{m.explanation}</p>
      )}
    </Card>
  );
}

export default async function AssistanceDetailPage({ params }: { params: { id: string } }) {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role !== 'instructor' && me.role !== 'admin') return <AccessDenied me={me} />;

  let detail: AssistanceDetail;
  try {
    detail = await serverApi.get<AssistanceDetail>(`/api/assistance/${Number(params.id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return (
        <>
          <Header me={me} />
          <PageShell>
            <Card className="p-6">
              <h1 className="text-xl font-bold">Event not found</h1>
              <Muted className="mt-2">This assistance event doesn’t exist.</Muted>
              <Link href="/staff/assistance" className="mt-3 inline-block text-sm font-semibold text-primary">
                ← Back to the queue
              </Link>
            </Card>
          </PageShell>
        </>
      );
    }
    throw e;
  }

  return (
    <>
      <Header me={me} />
      <PageShell>
        <div className="mb-4">
          <Link href="/staff/assistance" className="text-sm font-semibold text-primary hover:underline">
            ← Back to the queue
          </Link>
        </div>

        <div className="flex flex-col gap-6">
          {/* Who + how long — the triage line. */}
          <Card className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold">{detail.student_name}</h1>
                <Muted className="mt-1">
                  Level {detail.current_level}
                  {detail.segment_name ? ` · ${detail.segment_name}` : ''} · stalled at level{' '}
                  {detail.level_at_trigger}
                </Muted>
              </div>
              <Badge tone="warning">Waiting {formatWaiting(detail.waiting_seconds)}</Badge>
            </div>
            <p className="mt-2 text-xs text-text-muted">Raised {formatDateTime(detail.created_at)}</p>
            {detail.tags_involved.length > 0 && (
              <div className="mt-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Topics involved</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {detail.tags_involved.map((t) => (
                    <Badge key={t} tone="primary">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* The failed missions — question, their answer, the correct one, why. */}
          <section aria-labelledby="failed-heading">
            <h2 id="failed-heading" className="mb-2 text-sm font-bold uppercase tracking-wide text-text-muted">
              Where they went wrong
            </h2>
            <div className="flex flex-col gap-3">
              {detail.failed_missions.length === 0 ? (
                <Muted>No failed-mission detail was captured for this event.</Muted>
              ) : (
                detail.failed_missions.map((m) => <FailedMission key={m.assignment_id} m={m} />)
              )}
            </div>
          </section>

          {/* Recent level history for context. */}
          {detail.level_history.length > 0 && (
            <section aria-labelledby="history-heading">
              <h2 id="history-heading" className="mb-2 text-sm font-bold uppercase tracking-wide text-text-muted">
                Recent level history
              </h2>
              <Card className="p-4">
                <ul className="flex flex-col gap-1 text-sm">
                  {detail.level_history.map((h, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 text-text-muted">
                      <span>
                        {h.from_level} → {h.to_level} · {h.reason}
                      </span>
                      <span className="text-xs">{formatDateTime(h.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {/* Actions. */}
          <Card className="p-6">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-text-muted">Action</h2>
            <AssistanceActions detail={detail} />
          </Card>
        </div>
      </PageShell>
    </>
  );
}
