'use client';
import { useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { Button } from './ui';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await clientApi.post('/api/logout');
    } finally {
      window.location.href = '/login';
    }
  }
  return (
    <Button variant="ghost" onClick={signOut} disabled={busy}>
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
