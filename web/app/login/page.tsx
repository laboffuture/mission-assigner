'use client';
import { useEffect, useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import type { DevUser, ItemsEnvelope } from '@/lib/api/types';
import { PageShell, Card, Button, Muted } from '@/components/ui';

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
      <Card className="p-6">
        <h1 className="text-xl font-bold">Mission Hub</h1>
        <Muted className="mt-1">
          Dev sign-in. In production students arrive automatically via Moodle SSO; here, pick a
          student to preview their experience.
        </Muted>

        {error && <p className="mt-4 rounded border border-border bg-danger-muted p-3 text-sm text-danger">{error}</p>}

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
    </PageShell>
  );
}
