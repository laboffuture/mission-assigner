'use client';
import { useState } from 'react';
import { clientApi } from '@/lib/api/client';
import type { Page, SubmissionRow } from '@/lib/api/types';
import { Badge, Button, Muted } from '@/components/ui';

/**
 * Submission log with proper cursor pagination: it starts from the server-fetched
 * first page and follows nextCursor for "Load more" — never a fixed limit — so a
 * student many weeks in can page through all their rows.
 */
function passed(band: string) {
  return band === 'pass' || band === 'pass_strong';
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function Row({ row }: { row: SubmissionRow }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate font-medium">{row.title}</p>
        <p className="text-xs text-text-muted">
          {formatDate(row.submitted_at)} · Level {row.difficulty}
        </p>
      </div>
      <Badge tone={passed(row.score_band) ? 'success' : 'danger'}>{passed(row.score_band) ? 'Passed' : 'Not passed'}</Badge>
    </li>
  );
}

export function SubmissionLog({
  studentId,
  initialItems,
  initialCursor,
}: {
  studentId: number;
  initialItems: SubmissionRow[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState<SubmissionRow[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const page = await clientApi.get<Page<SubmissionRow>>(
        `/api/submissions/${studentId}?cursor=${encodeURIComponent(cursor)}`
      );
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor ?? null);
    } catch {
      setError('Could not load more. Try again.');
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded border border-dashed border-border p-6 text-center">
        <p className="font-medium">No missions completed yet</p>
        <Muted className="mt-1">Your finished missions will show up here.</Muted>
      </div>
    );
  }

  return (
    <div>
      <ul className="flex flex-col">
        {items.map((r) => (
          <Row key={r.assignment_id} row={r} />
        ))}
      </ul>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {cursor && (
        <div className="mt-4 text-center">
          <Button variant="ghost" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
