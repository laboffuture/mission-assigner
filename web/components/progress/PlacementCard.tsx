import type { Segment } from '@/lib/api/types';
import { Badge, Card, Muted } from '@/components/ui';

/**
 * Plain-language placement: not just "Level 3", but what that means, what moved
 * the student here (the segment's why + prerequisites), and what moves them up.
 * Uses /api/segment/:id.
 */
export function PlacementCard({ segment }: { segment: Segment }) {
  if (!segment.segment) {
    return (
      <Card className="p-6">
        <h2 className="text-lg font-bold">Not placed yet</h2>
        <Muted className="mt-1">You’ll be placed into a level once you get started.</Muted>
      </Card>
    );
  }

  const seg = segment.segment;
  const level = segment.current_level;
  const ladder = [];
  for (let l = seg.min_level; l <= seg.max_level; l++) ladder.push(l);

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold">
        Level {level} in {seg.name}
      </h2>
      {seg.description && <Muted className="mt-1">{seg.description}</Muted>}

      {/* Level ladder — where you are in this segment's range. */}
      <div className="mt-4 flex items-center gap-2">
        {ladder.map((l) => (
          <div
            key={l}
            className={`flex h-9 w-9 items-center justify-center rounded-full border text-sm font-bold ${
              l === level ? 'border-primary bg-primary text-primary-fg' : 'border-border bg-surface text-text-muted'
            }`}
          >
            {l}
          </div>
        ))}
        <span className="ml-2 text-sm text-text-muted">
          Level {level} of {seg.min_level}–{seg.max_level}
        </span>
      </div>

      {/* Why you're here. */}
      <p className="mt-4 text-sm">{segment.why}</p>

      {/* What moved you here — prerequisites. */}
      {segment.prerequisites.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Prerequisites</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {segment.prerequisites.map((p) => (
              <Badge key={p.course_ref} tone={p.completed ? 'success' : 'warning'}>
                {p.course_ref} {p.completed ? '✓' : '· needed'}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* What moves you up — plain mechanics. */}
      <p className="mt-4 rounded bg-surface-muted p-3 text-sm text-text-muted">
        Answer correctly to move up a level. A wrong answer never moves you down.
      </p>
    </Card>
  );
}
