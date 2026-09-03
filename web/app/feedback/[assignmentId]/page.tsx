import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { serverApi } from '@/lib/api/server';
import type { FeedbackQuestion, ItemsEnvelope } from '@/lib/api/types';
import { Header } from '@/components/Header';
import { PageShell } from '@/components/ui';
import { FeedbackForm } from '@/components/feedback/FeedbackForm';

/**
 * Feedback form. Shown after every graded mission. The questions come ENTIRELY
 * from /api/feedback/questions — prompts, answer types and options are all
 * data-driven, so editing a question in the DB changes this screen with no code
 * change. Fetched server-side so the form paints instantly (no loading flash on a
 * screen students see many times a week).
 */
export default async function FeedbackPage({ params }: { params: { assignmentId: string } }) {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role !== 'student') redirect('/');

  const assignmentId = Number(params.assignmentId);
  const { items: questions } = await serverApi.get<ItemsEnvelope<FeedbackQuestion>>('/api/feedback/questions');

  return (
    <>
      <Header me={me} />
      <PageShell>
        <FeedbackForm assignmentId={assignmentId} questions={questions} />
      </PageShell>
    </>
  );
}
