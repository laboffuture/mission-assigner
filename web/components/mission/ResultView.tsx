import Link from 'next/link';
import type { MissionOption, SubmitResponse } from '@/lib/api/types';
import { Badge, Button, Card } from '@/components/ui';

/**
 * The result IS the teaching moment. The verdict is kept deliberately small; the
 * explanation is the visual hero so a student who got it wrong is drawn to WHY,
 * not to a big red banner. The next action is always explicit.
 */
export function ResultView({
  options,
  selectedKey,
  result,
}: {
  options: MissionOption[];
  selectedKey: string;
  result: SubmitResponse;
}) {
  const correctKey = result.correct_option_key;
  const correctText = options.find((o) => o.option_key === correctKey)?.option_text ?? '';
  const goFeedback = result.feedback.gates_unlock && result.feedback.required;

  return (
    <div className="flex flex-col gap-5">
      {/* Compact verdict — intentionally understated. */}
      <div className="flex items-center gap-3">
        <Badge tone={result.correct ? 'success' : 'danger'}>{result.correct ? 'Correct' : 'Not quite'}</Badge>
        {result.xp.points_earned > 0 && (
          <span className="text-sm text-text-muted">+{result.xp.points_earned} XP</span>
        )}
      </div>

      {/* Options recap — mark the correct answer, and the student's choice if different. */}
      <ul className="flex flex-col gap-2">
        {options.map((o) => {
          const isCorrect = o.option_key === correctKey;
          const isChosen = o.option_key === selectedKey;
          const tone = isCorrect ? 'border-success bg-success-muted' : isChosen ? 'border-danger bg-danger-muted' : 'border-border bg-surface';
          return (
            <li key={o.option_key} className={`flex items-center justify-between rounded border px-4 py-2 ${tone}`}>
              <span>
                <span className="font-semibold uppercase">{o.option_key}.</span> {o.option_text}
              </span>
              <span className="flex gap-1">
                {isCorrect && <Badge tone="success">Correct answer</Badge>}
                {isChosen && !isCorrect && <Badge tone="danger">Your answer</Badge>}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Explanation — the hero. Accent draws the eye, especially when wrong. */}
      <Card
        className={`border-l-4 p-5 ${result.correct ? 'border-l-success' : 'border-l-warning'}`}
      >
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">
          {result.correct ? 'Why this is the answer' : 'Here’s why'}
        </h2>
        <p className="mt-2 text-lg leading-relaxed">
          {result.explanation || `The correct answer is ${correctKey.toUpperCase()}: ${correctText}.`}
        </p>
      </Card>

      {/* Next action — never a dead end. */}
      <div className="flex flex-col gap-2">
        {goFeedback ? (
          <>
            <Link href={`/feedback/${result.assignment_id}`}>
              <Button className="w-full sm:w-auto">Give feedback to continue →</Button>
            </Link>
            <p className="text-sm text-text-muted">A quick bit of feedback unlocks your next mission.</p>
          </>
        ) : (
          <Link href="/week">
            <Button className="w-full sm:w-auto">Back to this week →</Button>
          </Link>
        )}
      </div>
    </div>
  );
}
