'use client';
import Link from 'next/link';
import { useState } from 'react';
import { clientApi } from '@/lib/api/client';
import type { AssistanceListItem, Page } from '@/lib/api/types';
import { Badge, Card, Button, Muted } from '@/components/ui';
import { formatWaiting, waitingUrgency, formatDateTime } from '@/lib/time';

const URGENCY_TONE = { high: 'danger', medium: 'warning', low: 'neutral' } as const;
const URGENCY_WORD = { high: 'Waiting', medium: 'Waiting', low: 'Waiting' };

function Row({ e }: { e: AssistanceListItem }) {
  const urgency = waitingUrgency(e.waiting_seconds);
  return (
    <li>
      <Link
        href={`/staff/assistance/${e.id}`}
        className="flex items-center justify-between gap-4 border-b border-border px-1 py-4 last:border-b-0 hover:bg-surface-muted"
      >
        <div className="min-w-0">
          <p className="font-semibold">{e.student_name}</p>
          <p className="text-sm text-text-muted">
            Level {e.current_level}
            {e.segment_name ? ` · ${e.segment_name}` : ''}
            {e.tags_involved.length > 0 ? ` · ${e.tags_involved.join(', ')}` : ''}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">Raised {formatDateTime(e.created_at)}</p>
        </div>
        <div className="shrink-0 text-right">
          <Badge tone={URGENCY_TONE[urgency]}>
            {URGENCY_WORD[urgency]} {formatWaiting(e.waiting_seconds)}
          </Badge>
          <p className="mt-1 text-xs font-semibold text-primary">Review →</p>
        </div>
      </Link>
    </li>
  );
}

export function AssistanceQueue({
  initialItems,
  initialCursor,
}: {
  initialItems: AssistanceListItem[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const page = await clientApi.get<Page<AssistanceListItem>>(
        `/api/assistance?cursor=${encodeURIComponent(cursor)}`
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
      <Card className="p-8 text-center">
        <p className="text-2xl" aria-hidden="true">
          ✓
        </p>
        <h2 className="mt-2 text-lg font-bold">Nothing needs attention</h2>
        <Muted className="mt-1">No students are waiting for help right now.</Muted>
      </Card>
    );
  }

  return (
    <Card className="px-5 py-2">
      <ul className="flex list-none flex-col">
        {items.map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </ul>
      {error && <p className="py-3 text-sm text-danger">{error}</p>}
      {cursor && (
        <div className="py-4 text-center">
          <Button variant="ghost" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </Card>
  );
}
