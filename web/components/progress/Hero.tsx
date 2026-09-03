import type { Progress } from '@/lib/api/types';
import { Card } from '@/components/ui';

/**
 * The motivating numbers, led by level and streak (largest), with the XP total
 * as a secondary line. New students (no streak yet) read as a starting point,
 * not a broken screen.
 */
export function Hero({ progress }: { progress: Progress }) {
  const streak = progress.current_streak;
  return (
    <Card className="p-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="text-center">
          <p className="text-5xl font-extrabold text-primary">{progress.current_level}</p>
          <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-text-muted">Level</p>
        </div>
        <div className="text-center">
          <p className="text-5xl font-extrabold text-warning">{streak > 0 ? `🔥 ${streak}` : '0'}</p>
          <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-text-muted">
            {streak > 0 ? `Day streak` : 'Start your streak'}
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-center gap-2 border-t border-border pt-4">
        <span className="text-2xl font-bold">{progress.total_xp}</span>
        <span className="text-sm text-text-muted">XP total</span>
        {progress.longest_streak > 0 && (
          <span className="ml-3 text-sm text-text-muted">· best streak {progress.longest_streak}</span>
        )}
      </div>
    </Card>
  );
}
