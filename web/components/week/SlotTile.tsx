import Link from 'next/link';
import type { Slot } from '@/lib/api/types';
import { slotState, STATE_LABEL, titleCase, type SlotState } from '@/lib/week';
import { Badge } from '@/components/ui';

/** Slot chips shared by every tile — metadata only (safe for locked slots). */
function MetaChips({ slot }: { slot: Slot }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <Badge tone="neutral">{titleCase(slot.mission_type)}</Badge>
      <Badge tone="neutral">{titleCase(slot.time_band)}</Badge>
    </div>
  );
}

const STATE_TONE: Record<SlotState, 'success' | 'primary' | 'locked'> = {
  done: 'success',
  open: 'primary',
  locked: 'locked',
};

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * Locked tile — renders from METADATA ALONE. Its `slot` type is the locked
 * variant, which has no `mission` property, so there is no type-legal way for
 * this component to display question text even if content leaked into the payload.
 */
function LockedTile({ slot }: { slot: Extract<Slot, { kind: 'locked' }> }) {
  return (
    <div className="flex h-full w-40 shrink-0 flex-col rounded-lg border border-border bg-surface-muted p-3 opacity-90">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-text-muted">{slot.day_label}</span>
        <span className="text-locked">
          <LockIcon />
        </span>
      </div>
      <MetaChips slot={slot} />
      <span className="mt-auto pt-3 text-xs font-medium text-locked">{STATE_LABEL.locked}</span>
    </div>
  );
}

/** Open / done tile. Shows the student's own mission title when available. */
function ActiveTile({ slot }: { slot: Extract<Slot, { kind: 'empty' } | { kind: 'filled' }> }) {
  const state = slotState(slot);
  const title = slot.mission?.title ?? null;
  const cta = state === 'done' ? 'Review' : title ? 'Continue' : 'Start';
  return (
    <Link
      href={`/mission/${slot.slot_id}`}
      className="flex h-full w-40 shrink-0 flex-col rounded-lg border border-border bg-surface p-3 shadow-card transition hover:border-primary"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{slot.day_label}</span>
        <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
      </div>
      <MetaChips slot={slot} />
      {title && <span className="mt-2 line-clamp-2 text-sm text-text-muted">{title}</span>}
      <span className="mt-auto pt-3 text-xs font-semibold text-primary">{cta} →</span>
    </Link>
  );
}

export function SlotTile({ slot }: { slot: Slot }) {
  if (slot.kind === 'locked') return <LockedTile slot={slot} />;
  return <ActiveTile slot={slot} />;
}
