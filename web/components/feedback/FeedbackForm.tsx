'use client';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import type { FeedbackQuestion, FeedbackSubmitResponse } from '@/lib/api/types';
import { Button, Card, Muted } from '@/components/ui';

/**
 * Data-driven feedback form. Every prompt, answer type and option comes from the
 * `questions` prop (which is /api/feedback/questions) — nothing about a question
 * is hardcoded, so editing a question in the DB changes this screen with no code
 * change. Defaults nothing; validates required answers in the CLIENT before
 * submitting so a missed question never discards the others (the server rejects
 * an incomplete submission atomically and saves nothing).
 */

const SCALE = ['1', '2', '3', '4', '5'];

function Choice({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-full border px-4 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
        active ? 'border-primary bg-primary text-primary-fg' : 'border-border bg-surface hover:border-primary'
      }`}
    >
      {label}
    </button>
  );
}

function QuestionControl({
  q,
  value,
  onChange,
  disabled,
}: {
  q: FeedbackQuestion;
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
        onChange={(e) => onChange(e.target.value)}
        placeholder="Optional"
        className="w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
      />
    );
  }
  const choices =
    q.answer_type === 'scale_1_5' ? SCALE : q.answer_type === 'yes_no' ? ['yes', 'no'] : (q.options ?? []);
  return (
    <div className="flex flex-wrap gap-2">
      {choices.map((c) => (
        <Choice
          key={c}
          label={q.answer_type === 'yes_no' ? (c === 'yes' ? 'Yes' : 'No') : c}
          active={value === c}
          onClick={() => onChange(c)}
          disabled={disabled}
        />
      ))}
    </div>
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
        {ordered.map((q) => (
          <div key={q.question_key}>
            <label className="text-sm font-semibold">
              {q.prompt}
              {q.required && <span className="text-danger"> *</span>}
            </label>
            <div className="mt-1.5">
              <QuestionControl
                q={q}
                value={answers[q.question_key]}
                onChange={(v) => setAnswer(q.question_key, v)}
                disabled={disabled}
              />
            </div>
            {missing.has(q.question_key) && <p className="mt-1 text-xs text-danger">Please answer this one.</p>}
          </div>
        ))}
      </div>

      {phase === 'error' && (
        <p className="mt-4 rounded border border-border bg-danger-muted p-3 text-sm text-danger">{errorMsg}</p>
      )}
      {missing.size > 0 && (
        <p className="mt-4 text-sm text-danger">Please answer the highlighted question{missing.size > 1 ? 's' : ''}.</p>
      )}

      <div className="mt-5">
        <Button onClick={submit} disabled={disabled}>
          {disabled ? 'Saving…' : 'Submit & continue'}
        </Button>
      </div>
    </Card>
  );
}
