/** Humanise a waiting duration (seconds) as e.g. "3 days", "5 hours", "12 min". */
export function formatWaiting(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m >= 1) return `${m} min`;
  return 'just now';
}

/** Urgency band for a waiting duration — used for a non-colour-alone signal. */
export function waitingUrgency(seconds: number): 'high' | 'medium' | 'low' {
  if (seconds >= 2 * 86400) return 'high'; // 2+ days waiting
  if (seconds >= 86400) return 'medium'; // 1+ day
  return 'low';
}

/** Format an ISO timestamp as a readable date-time, falling back to the raw value. */
export function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
