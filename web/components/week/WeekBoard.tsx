import type { Slot } from '@/lib/api/types';
import { slotState, formatWeekStart } from '@/lib/week';
import { Card } from '@/components/ui';
import { SlotTile } from './SlotTile';
import { WeeklyCard } from './WeeklyCard';

function count(slots: Slot[], state: 'done' | 'open' | 'locked') {
  return slots.filter((s) => slotState(s) === state).length;
}

function LegendDot({ className, label, n }: { className: string; label: string; n: number }) {
  return (
    <span className="flex items-center gap-1.5 text-sm text-text-muted">
      <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${className}`} />
      <strong className="text-text">{n}</strong> {label}
    </span>
  );
}

export function WeekBoard({
  weekStart,
  dailySlots,
  weeklySlot,
}: {
  weekStart: string;
  dailySlots: Slot[];
  weeklySlot: Slot | null;
}) {
  const done = count(dailySlots, 'done');
  const open = count(dailySlots, 'open');
  const locked = count(dailySlots, 'locked');
  const total = dailySlots.length || 1;
  const pct = Math.round((done / total) * 100);

  return (
    <div className="flex flex-col gap-6">
      {/* Overview — the week's shape at a glance. */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">This week</h1>
            <p className="text-sm text-text-muted">Week of {formatWeekStart(weekStart)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <LegendDot className="bg-success" label="done" n={done} />
            <LegendDot className="bg-primary" label="open now" n={open} />
            <LegendDot className="bg-locked" label="coming" n={locked} />
          </div>
        </div>
        <div
          className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={dailySlots.length}
          aria-label={`${done} of ${dailySlots.length} daily missions done`}
        >
          <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-sm text-text-muted">
          {done} of {dailySlots.length} daily missions done
        </p>
      </Card>

      {/* Daily sequence — ordered tiles. */}
      <section aria-labelledby="daily-heading">
        <h2 id="daily-heading" className="mb-2 text-sm font-bold uppercase tracking-wide text-text-muted">
          Daily sequence
        </h2>
        {dailySlots.length === 0 ? (
          <p className="text-sm text-text-muted">No daily missions this week.</p>
        ) : (
          <ul className="flex list-none gap-3 overflow-x-auto pb-2">
            {dailySlots.map((s) => (
              <li key={s.slot_id} className="flex">
                <SlotTile slot={s} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Weekly mission — outside the sequence. */}
      {weeklySlot && <WeeklyCard slot={weeklySlot} />}
    </div>
  );
}
