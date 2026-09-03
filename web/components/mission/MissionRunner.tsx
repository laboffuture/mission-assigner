'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import {
  isOpenSlotEmpty,
  type OpenSlotPayload,
  type OpenSlotResponse,
  type SubmitResponse,
} from '@/lib/api/types';
import { Badge, Button, Card, Muted } from '@/components/ui';
import { ErrorState } from '@/components/states';
import { ResultView } from './ResultView';

type Phase =
  | { name: 'loading' }
  | { name: 'empty'; message: string }
  | { name: 'loadError'; message: string }
  | { name: 'answering'; mission: OpenSlotResponse }
  | { name: 'submitting'; mission: OpenSlotResponse }
  | { name: 'result'; mission: OpenSlotResponse; selectedKey: string; result: SubmitResponse };

export function MissionRunner({ slotId }: { slotId: number }) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [selected, setSelected] = useState<string>('');
  const [submitError, setSubmitError] = useState('');

  const submittingRef = useRef(false); // synchronous double-tap lock
  const idemKeyRef = useRef<string | null>(null); // ONE key per attempt, reused on retry

  // Open the slot (lazy-fill + attempt XP). Reusable so a failed open can retry.
  const loadOpen = useCallback(() => {
    setPhase({ name: 'loading' });
    clientApi
      .post<OpenSlotPayload>(`/api/slot/${slotId}/open`)
      .then((res) =>
        setPhase(isOpenSlotEmpty(res) ? { name: 'empty', message: res.message } : { name: 'answering', mission: res })
      )
      .catch((e) =>
        setPhase({ name: 'loadError', message: e instanceof ApiError ? e.message : 'Could not load this mission.' })
      );
  }, [slotId]);

  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    loadOpen();
  }, [loadOpen]);

  async function submit(mission: OpenSlotResponse) {
    // Double-tap safety: bail synchronously if a submit is already in flight.
    if (submittingRef.current || !selected) return;
    submittingRef.current = true;
    setSubmitError('');
    setPhase({ name: 'submitting', mission });

    // Reuse ONE Idempotency-Key across retries: if the network dropped after the
    // server graded (but before we saw the response), retrying with the same key
    // returns the ORIGINAL result instead of creating a second attempt.
    if (!idemKeyRef.current) idemKeyRef.current = crypto.randomUUID();

    try {
      const result = await clientApi.post<SubmitResponse>(
        '/api/submit',
        { assignmentId: mission.assignment_id, selected },
        { 'Idempotency-Key': idemKeyRef.current }
      );
      setPhase({ name: 'result', mission, selectedKey: selected, result });
    } catch (e) {
      // Keep the mission and the chosen answer so the student can simply retry —
      // the reused key makes that safe. Only genuine (non-401) failures land here;
      // a 401 is intercepted in the client and redirects to /login.
      submittingRef.current = false;
      setSubmitError(
        e instanceof ApiError ? `${e.message}. Your answer is safe — try again.` : 'Network problem — your answer is safe, try again.'
      );
      setPhase({ name: 'answering', mission });
    }
  }

  if (phase.name === 'loading') {
    return (
      <Card className="p-6">
        <Muted>Loading your mission…</Muted>
      </Card>
    );
  }

  if (phase.name === 'loadError') {
    return <ErrorState title="Couldn’t load this mission" message={phase.message} onRetry={loadOpen} />;
  }

  if (phase.name === 'empty') {
    return (
      <Card className="p-6">
        <h1 className="text-xl font-bold">No mission available right now</h1>
        <Muted className="mt-2">
          {phase.message || 'There’s no mission ready for this slot yet — please contact your instructor.'}
        </Muted>
        <div className="mt-4">
          <Link href="/week">
            <Button variant="ghost">Back to this week</Button>
          </Link>
        </div>
      </Card>
    );
  }

  if (phase.name === 'result') {
    return (
      <div className="flex flex-col gap-5">
        <MissionHeader mission={phase.mission} />
        <ResultView options={phase.mission.options} selectedKey={phase.selectedKey} result={phase.result} />
      </div>
    );
  }

  // answering | submitting
  const mission = phase.mission;
  const submitting = phase.name === 'submitting';
  return (
    <div className="flex flex-col gap-5">
      <MissionHeader mission={mission} />
      <Card className="p-6">
        <p className="text-lg leading-relaxed">{mission.body}</p>
        <fieldset className="mt-4 flex flex-col gap-2" disabled={submitting}>
          {mission.options.map((o) => {
            const active = selected === o.option_key;
            return (
              <label
                key={o.option_key}
                className={`flex cursor-pointer items-center gap-3 rounded border px-4 py-3 ${active ? 'border-primary bg-primary-muted' : 'border-border bg-surface'}`}
              >
                <input
                  type="radio"
                  name="option"
                  value={o.option_key}
                  checked={active}
                  onChange={() => setSelected(o.option_key)}
                  className="accent-primary"
                />
                <span>
                  <span className="font-semibold uppercase">{o.option_key}.</span> {o.option_text}
                </span>
              </label>
            );
          })}
        </fieldset>
      </Card>
      {submitError && (
        <p className="rounded border border-border bg-danger-muted p-3 text-sm text-danger">{submitError}</p>
      )}
      <div>
        <Button onClick={() => submit(mission)} disabled={!selected || submitting}>
          {submitting ? 'Submitting…' : submitError ? 'Try again' : 'Submit answer'}
        </Button>
      </div>
    </div>
  );
}

function MissionHeader({ mission }: { mission: OpenSlotResponse }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-xl font-bold">{mission.title}</h1>
      <Badge tone="neutral">Level {mission.difficulty}</Badge>
    </div>
  );
}
