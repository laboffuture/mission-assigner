import { redirect } from 'next/navigation';
import { getMe } from '@/lib/session';
import { Header } from '@/components/Header';
import { PageShell, Card, Muted } from '@/components/ui';

/**
 * Landing. Server component: resolves identity via /api/me (real API, cookie
 * forwarded). Unauthenticated → the login/launch entry. Students land on the
 * week board (built next). Staff are out of scope for this surface.
 */
export default async function Home() {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.role === 'student') redirect('/week');

  // Staff who signed in (e.g. via dev login-as) — this is the student surface only.
  return (
    <>
      <Header me={me} />
      <PageShell>
        <Card className="p-6">
          <h1 className="text-xl font-bold">Signed in as {me.display_name ?? `user ${me.id}`}</h1>
          <Muted className="mt-2">
            This is the student surface. Your role is <strong>{me.role}</strong> — the staff and
            instructor tools live elsewhere.
          </Muted>
        </Card>
      </PageShell>
    </>
  );
}
