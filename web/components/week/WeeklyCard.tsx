import Link from 'next/link';
import type { Slot } from '@/lib/api/types';
import { slotState, STATE_LABEL, STATE_SYMBOL, titleCase, type SlotState } from '@/lib/week';
import { Badge, Card } from '@/components/ui';

const STATE_TONE: Record<SlotState, 'success' | 'primary' | 'locked'> = {
  done: 'success',
  open: 'primary',
  locked: 'locked',
};

/** The weekly mission, set apart from the daily sequence. Locked → metadata only. */
export function WeeklyCard({ slot }: { slot: Slot }) {
  const state = slotState(slot);
  const locked = slot.kind === 'locked';
  const title = slot.kind === 'filled' ? slot.mission.title : null;

  return (
    <Card className="p-5">
      {locked && <span className="sr-only">Weekly mission, locked. Unlocks later this week.</span>}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold uppercase tracking-wide text-primary">Weekly mission</span>
          <Badge tone="primary">Outside the daily sequence</Badge>
        </div>
        <Badge tone={STATE_TONE[state]}>
          <span aria-hidden="true">{STATE_SYMBOL[state]} </span>
          {STATE_LABEL[state]}
        </Badge>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="font-semibold">{slot.day_label}</span>
        <Badge tone="neutral">{titleCase(slot.mission_type)}</Badge>
        <Badge tone="neutral">{titleCase(slot.time_band)}</Badge>
      </div>

      {/* Content only for a non-locked weekly slot. */}
      {locked ? (
        <p className="mt-3 text-sm text-text-muted">Unlocks later this week.</p>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-4">
          {title && <span className="text-sm text-text-muted">{title}</span>}
          <Link
            href={`/mission/${slot.slot_id}`}
            className="shrink-0 text-sm font-semibold text-primary hover:underline"
          >
            {state === 'done' ? 'Review' : 'Open weekly mission'} →
          </Link>
        </div>
      )}
    </Card>
  );
}
