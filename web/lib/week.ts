import type { Slot } from './api/types';

/**
 * The at-a-glance state a student reads off the board. Derived from the slot's
 * status/kind (the DB slot status is locked | open | submitted):
 *   done   — already submitted
 *   open   — available to work on now
 *   locked — still to come (metadata only; never any question text)
 */
export type SlotState = 'done' | 'open' | 'locked';

export function slotState(slot: Slot): SlotState {
  if (slot.status === 'submitted') return 'done';
  if (slot.kind === 'locked' || slot.status === 'locked') return 'locked';
  return 'open';
}

export const STATE_LABEL: Record<SlotState, string> = {
  done: 'Done',
  open: 'Open now',
  locked: 'Coming up',
};

/** Human label for a mission type / time band chip. */
export function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Format an ISO/date string as e.g. "Mon 31 Aug". Falls back to the raw value. */
export function formatWeekStart(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
