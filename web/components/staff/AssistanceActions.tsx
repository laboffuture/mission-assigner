'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import type { AssistanceDetail } from '@/lib/api/types';
import { Badge, Button, Muted } from '@/components/ui';
import { formatDateTime } from '@/lib/time';

/**
 * Acknowledge / resolve actions for one assistance event. The resolve note is
 * required and validated in the client before submitting. On success it refreshes
 * the server component so the detail (and the queue behind it) reflect the new
 * status.
 */
export function AssistanceActions({ detail }: { detail: AssistanceDetail }) {
  const router = useRouter();
  const [status, setStatus] = useState(detail.status);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<null | 'ack' | 'resolve'>(null);

  if (status === 'resolved') {
    return (
      <div className="rounded border border-border bg-success-muted p-4">
        <div className="flex items-center gap-2">
          <Badge tone="success">✓ Resolved</Badge>
          <span className="text-sm text-text-muted">{formatDateTime(detail.resolved_at)}</span>
        </div>
        {detail.resolution_note && <p className="mt-2 text-sm">{detail.resolution_note}</p>}
      </div>
    );
  }

  async function acknowledge() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('ack');
    setError('');
    try {
      const updated = await clientApi.post<AssistanceDetail>(`/api/assistance/${detail.id}/acknowledge`);
      setStatus(updated.status);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not acknowledge. Try again.');
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function resolve() {
    if (busyRef.current) return;
    // Client-side required-note check first.
    if (note.trim().length === 0) {
      setNoteError('Describe what you did before resolving.');
      return;
    }
    busyRef.current = true;
    setBusy('resolve');
    setError('');
    setNoteError('');
    try {
      const updated = await clientApi.post<AssistanceDetail>(`/api/assistance/${detail.id}/resolve`, {
        note: note.trim(),
      });
      setStatus(updated.status);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not resolve. Try again.');
      busyRef.current = false;
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Status:</span>
        <Badge tone={status === 'acknowledged' ? 'primary' : 'warning'}>
          {status === 'acknowledged' ? 'Acknowledged' : 'Open'}
        </Badge>
        {status === 'acknowledged' && detail.acknowledged_at && (
          <span className="text-xs text-text-muted">since {formatDateTime(detail.acknowledged_at)}</span>
        )}
      </div>

      {status === 'open' && (
        <div>
          <Button variant="ghost" onClick={acknowledge} disabled={busy !== null}>
            {busy === 'ack' ? 'Marking…' : 'Acknowledge'}
          </Button>
          <Muted className="mt-1">Mark that you’ve seen this, before you’ve finished acting on it.</Muted>
        </div>
      )}

      <div>
        <label htmlFor="resolve-note" className="text-sm font-semibold">
          Resolution note <span className="text-danger">*</span>
        </label>
        <textarea
          id="resolve-note"
          rows={3}
          maxLength={1000}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            if (noteError) setNoteError('');
          }}
          placeholder="What did you do? e.g. Called the student and re-explained loops."
          className="mt-1 w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm"
        />
        {noteError && (
          <p className="mt-1 text-sm text-danger" role="alert">
            {noteError}
          </p>
        )}
        {error && (
          <p className="mt-1 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="mt-2">
          <Button onClick={resolve} disabled={busy !== null}>
            {busy === 'resolve' ? 'Resolving…' : 'Resolve'}
          </Button>
        </div>
      </div>
    </div>
  );
}
