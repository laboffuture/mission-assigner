import Link from 'next/link';
import type { AssignmentReview } from '@/lib/api/types';
import { Badge, Button, Card } from '@/components/ui';

/**
 * Read-only review of a completed mission: the question, the student's answer,
 * the correct answer and the explanation. Mirrors the post-submit result screen
 * so revisiting a done mission feels the same as finishing it — the same teaching
 * moment, available again. Never colour-alone (glyph + word markers).
 */
export function ReviewView({ review }: { review: AssignmentReview }) {
  const correctText = review.correct_text ?? '';
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{review.title}</h1>
        <Badge tone="neutral">Level {review.difficulty}</Badge>
      </div>

      <Card className="p-6">
        <p className="text-lg leading-relaxed">{review.body}</p>
      </Card>

      <div className="flex items-center gap-3" role="status">
        <Badge tone={review.correct ? 'success' : 'danger'}>
          <span aria-hidden="true">{review.correct ? '✓ ' : '✗ '}</span>
          {review.correct ? 'You got this right' : 'You answered this wrong'}
        </Badge>
      </div>

      <ul className="flex flex-col gap-2">
        {review.options.map((o) => {
          const isCorrect = o.option_key === review.correct_key;
          const isChosen = o.option_key === review.selected_key;
          const tone = isCorrect
            ? 'border-success bg-success-muted'
            : isChosen
              ? 'border-danger bg-danger-muted'
              : 'border-border bg-surface';
          return (
            <li key={o.option_key} className={`flex items-center justify-between gap-3 rounded border px-4 py-2 ${tone}`}>
              <span>
                <span aria-hidden="true" className="mr-1 font-bold">
                  {isCorrect ? '✓' : isChosen ? '✗' : ' '}
                </span>
                <span className="font-semibold uppercase">{o.option_key}.</span> {o.option_text}
              </span>
              <span className="flex shrink-0 gap-1">
                {isCorrect && <Badge tone="success">Correct answer</Badge>}
                {isChosen && !isCorrect && <Badge tone="danger">Your answer</Badge>}
              </span>
            </li>
          );
        })}
      </ul>

      <Card className={`border-l-4 p-5 ${review.correct ? 'border-l-success' : 'border-l-warning'}`}>
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">
          {review.correct ? 'Why this is the answer' : 'Here’s why'}
        </h2>
        <p className="mt-2 text-lg leading-relaxed">
          {review.explanation || `The correct answer is ${review.correct_key.toUpperCase()}: ${correctText}.`}
        </p>
      </Card>

      <div>
        <Link href="/week">
          <Button>Back to this week →</Button>
        </Link>
      </div>
    </div>
  );
}
