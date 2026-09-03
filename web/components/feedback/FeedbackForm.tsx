'use client';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import type { FeedbackQuestion, FeedbackSubmitResponse } from '@/lib/api/types';
import { Button, Card, Muted } from '@/components/ui';
import { RadioGroup, type RadioOption } from '@/components/RadioGroup';

/**
 * Data-driven feedback form. Every prompt, answer type and option comes from the
 * `questions` prop (which is /api/feedback/questions) — nothing about a question
 * is hardcoded, so editing a question in the DB changes this screen with no code
 * change. Defaults nothing; validates required answers in the CLIENT before
 * submitting so a missed question never discards the others (the server rejects
 * an incomplete submission atomically and saves nothing).
 */

/** Build the radio options for a question's answer type. */
function optionsFor(q: FeedbackQuestion): RadioOption[] {
  switch (q.answer_type) {
    case 'scale_1_5':
      // Endpoint anchors in the accessible name so a scale isn't just bare numbers.
      return ['1', '2', '3', '4', '5'].map((n) => ({
        value: n,
        label: n,
        ariaLabel: n === '1' ? '1, lowest' : n === '5' ? '5, highest' : n,
      }));
    case 'yes_no':
      return [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ];
    default:
      return (q.options ?? []).map((o) => ({ value: o, label: o }));
  }
}

function QuestionControl({
  q,
  labelId,
  value,
  onChange,
  disabled,
}: {
  q: FeedbackQuestion;
  labelId: string;
  value: string | undefined;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  if (q.answer_type === 'free_text') {
    return (
      <textarea
        rows={2}
        maxLength={500}
        value={value ?? ''}
        disabled={disabled}
        aria-labelledby={labelId}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Optional"
        className="w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm"
      />
    );
  }
  const isScale = q.answer_type === 'scale_1_5';
  return (
    <RadioGroup
      name={q.question_key}
      legendId={labelId}
      options={optionsFor(q)}
      value={value}
      onChange={onChange}
      disabled={disabled}
      startCaption={isScale ? 'Low' : undefined}
      endCaption={isScale ? 'High' : undefined}
    />
  );
}

export function FeedbackForm({ assignmentId, questions }: { assignmentId: number; questions: FeedbackQuestion[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [result, setResult] = useState<FeedbackSubmitResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const submittingRef = useRef(false);

  const ordered = useMemo(() => [...questions].sort((a, b) => a.display_order - b.display_order), [questions]);

  function setAnswer(key: string, v: string) {
    setAnswers((prev) => ({ ...prev, [key]: v }));
    if (missing.has(key)) {
      setMissing((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function isAnswered(q: FeedbackQuestion): boolean {
    const v = answers[q.question_key];
    return v != null && v.trim() !== '';
  }

  async function submit() {
    if (submittingRef.current) return;

    // Client-side required check FIRST — so a missing answer never costs the rest.
    const gaps = ordered.filter((q) => q.required && !isAnswered(q));
    if (gaps.length > 0) {
      setMissing(new Set(gaps.map((q) => q.question_key)));
      return;
    }

    submittingRef.current = true;
    setPhase('submitting');
    const payload = {
      answers: ordered.filter(isAnswered).map((q) => ({ question_key: q.question_key, value: answers[q.question_key] })),
    };
    try {
      const res = await clientApi.post<FeedbackSubmitResponse>(`/api/feedback/${assignmentId}`, payload);
      setResult(res);
      setPhase('done');
    } catch (e) {
      submittingRef.current = false;
      setErrorMsg(e instanceof ApiError ? e.message : 'Could not save your feedback. Please try again.');
      setPhase('error');
    }
  }

  if (phase === 'done' && result) {
    const points = result.xp.awarded ? result.xp.points : 0;
    return (
      <Card className="p-6 text-center">
        {points > 0 ? (
          <p className="text-3xl font-extrabold text-success">+{points} XP</p>
        ) : (
          <p className="text-2xl font-bold">Thanks!</p>
        )}
        <h1 className="mt-2 text-xl font-bold">Your next mission is ready</h1>
        <Muted className="mt-1">Nice work — the next slot is unlocked.</Muted>
        <div className="mt-5">
          <Link href="/week">
            <Button>Continue to this week →</Button>
          </Link>
        </div>
      </Card>
    );
  }

  const disabled = phase === 'submitting';
  return (
    <Card className="p-6">
      <h1 className="text-xl font-bold">Quick feedback</h1>
      <Muted className="mt-1">A few taps and your next mission unlocks.</Muted>

      <div className="mt-5 flex flex-col gap-4">
        {ordered.map((q) => {
          const labelId = `fql-${q.question_key}`;
          const isMissing = missing.has(q.question_key);
          return (
            <div key={q.question_key} data-testid={`fq-${q.question_key}`}>
              <span id={labelId} className="text-sm font-semibold">
                {q.prompt}
                {q.required && (
                  <span className="text-danger">
                    {' '}
                    *<span className="sr-only"> (required)</span>
                  </span>
                )}
              </span>
              <div className="mt-1.5">
                <QuestionControl
                  q={q}
                  labelId={labelId}
                  value={answers[q.question_key]}
                  onChange={(v) => setAnswer(q.question_key, v)}
                  disabled={disabled}
                />
              </div>
              {isMissing && <p className="mt-1 text-xs text-danger">Please answer this one.</p>}
            </div>
          );
        })}
      </div>

      <div aria-live="polite">
        {phase === 'error' && (
          <p className="mt-4 rounded border border-border bg-danger-muted p-3 text-sm text-danger">{errorMsg}</p>
        )}
        {missing.size > 0 && (
          <p className="mt-4 text-sm text-danger">
            Please answer the highlighted question{missing.size > 1 ? 's' : ''}.
          </p>
        )}
      </div>

      <div className="mt-5">
        <Button onClick={submit} disabled={disabled}>
          {disabled ? 'Saving…' : 'Submit & continue'}
        </Button>
      </div>
    </Card>
  );
}
