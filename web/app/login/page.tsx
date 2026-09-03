'use client';
import { useEffect, useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import type { DevUser, ItemsEnvelope, Me } from '@/lib/api/types';
import { PageShell, Card, Button, Muted } from '@/components/ui';

/** Where each role lands after sign-in. */
function homeFor(role: Me['role']): string {
  if (role === 'instructor' || role === 'admin') return '/staff/assistance';
  if (role === 'student') return '/';
  return '/'; // sme/qc — no dedicated Next surface yet
}

/** Staff username/password sign-in (reuses the Express session via /api/login). */
function StaffSignIn() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await clientApi.post<Me>('/api/login', { username, password });
      window.location.href = homeFor(me.role);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts — try again later.' : 'Invalid username or password.');
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold">Staff sign-in</h2>
      <Muted className="mt-1">Instructors, SMEs and admins sign in with a username and password.</Muted>
      <form className="mt-4 flex flex-col gap-3" onSubmit={submit}>
        <label className="text-sm font-semibold">
          Username
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm font-semibold">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        {error && <p className="rounded border border-border bg-danger-muted p-3 text-sm text-danger" role="alert">{error}</p>}
        <div>
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Dev launch entry — the stand-in for Moodle SSO while LTI is not wired up.
 * Reads the REAL dev roster (/api/dev/users) and signs in as a chosen student
 * via /api/dev/login-as, which mints the same session cookie the LTI launch will
 * eventually mint. No mock data: every user shown comes from the API.
 */
export default function LoginPage() {
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    clientApi
      .get<ItemsEnvelope<DevUser>>('/api/dev/users')
      .then((r) => setUsers(r.items.filter((u) => u.role === 'student')))
      .catch((e) =>
        setError(
          e instanceof ApiError && e.status === 404
            ? 'The dev roster is only available when the API runs with AUTH_MODE=dev.'
            : 'Could not load the dev roster.'
        )
      );
  }, []);

  async function loginAs(studentId: number) {
    setBusyId(studentId);
    setError(null);
    try {
      await clientApi.post('/api/dev/login-as', { studentId });
      window.location.href = '/';
    } catch {
      setError('Sign-in failed.');
      setBusyId(null);
    }
  }

  return (
    <PageShell>
      <div className="flex flex-col gap-6">
        <Card className="p-6">
          <h1 className="text-xl font-bold">Mission Hub</h1>
          <Muted className="mt-1">
            Student dev sign-in. In production students arrive automatically via Moodle SSO; here,
            pick a student to preview their experience.
          </Muted>

          {error && (
            <p className="mt-4 rounded border border-border bg-danger-muted p-3 text-sm text-danger">{error}</p>
          )}

          <div className="mt-5 flex flex-col gap-2">
            {users === null && !error && <Muted>Loading…</Muted>}
            {users?.length === 0 && <Muted>No students found. Seed the database first.</Muted>}
            {users?.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between rounded border border-border bg-surface-muted px-4 py-3"
              >
                <span className="font-medium">{u.display_name}</span>
                <Button onClick={() => loginAs(u.id)} disabled={busyId === u.id}>
                  {busyId === u.id ? 'Signing in…' : 'Sign in'}
                </Button>
              </div>
            ))}
          </div>
        </Card>

        <StaffSignIn />
      </div>
    </PageShell>
  );
}
