'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { clientApi } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import {
  isOpenSlotEmpty,
  type OpenSlotPayload,
  type OpenSlotResponse,
  type SubmitResponse,
} from '@/lib/api/types';
import { Badge, Button, Card, Muted } from '@/components/ui';
import { ResultView } from './ResultView';

type Phase =
  | { name: 'loading' }
  | { name: 'empty'; message: string }
  | { name: 'answering'; mission: OpenSlotResponse }
  | { name: 'submitting'; mission: OpenSlotResponse }
  | { name: 'result'; mission: OpenSlotResponse; selectedKey: string; result: SubmitResponse }
  | { name: 'error'; message: string };

export function MissionRunner({ slotId }: { slotId: number }) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [selected, setSelected] = useState<string>('');

  const openedRef = useRef(false); // open the slot exactly once
  const submittingRef = useRef(false); // synchronous double-tap lock
  const idemKeyRef = useRef<string | null>(null); // one key per attempt, reused on retry

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    clientApi
      .post<OpenSlotPayload>(`/api/slot/${slotId}/open`)
      .then((res) =>
        setPhase(isOpenSlotEmpty(res) ? { name: 'empty', message: res.message } : { name: 'answering', mission: res })
      )
      .catch((e) =>
        setPhase({ name: 'error', message: e instanceof ApiError ? e.message : 'Could not load this mission.' })
      );
  }, [slotId]);

  async function submit(mission: OpenSlotResponse) {
    // Double-tap safety: bail synchronously if a submit is already in flight, so
    // a second tap before React re-renders can't fire a second request.
    if (submittingRef.current || !selected) return;
    submittingRef.current = true;
    setPhase({ name: 'submitting', mission });

    // Reuse one Idempotency-Key: if two requests still slip through (or a retry),
    // the server returns the ORIGINAL graded result instead of creating another
    // attempt.
    if (!idemKeyRef.current) idemKeyRef.current = crypto.randomUUID();

    try {
      const result = await clientApi.post<SubmitResponse>(
        '/api/submit',
        { assignmentId: mission.assignment_id, selected },
        { 'Idempotency-Key': idemKeyRef.current }
      );
      setPhase({ name: 'result', mission, selectedKey: selected, result });
    } catch (e) {
      submittingRef.current = false;
      setPhase({ name: 'error', message: e instanceof ApiError ? e.message : 'Submit failed. Please try again.' });
    }
  }

  if (phase.name === 'loading') {
    return (
      <Card className="p-6">
        <Muted>Loading your mission…</Muted>
      </Card>
    );
  }

  if (phase.name === 'empty') {
    return (
      <BackNotice title="No mission available right now">
        {phase.message || 'There’s no mission ready for this slot yet — please contact your instructor.'}
      </BackNotice>
    );
  }

  if (phase.name === 'error') {
    return <BackNotice title="Something went wrong">{phase.message}</BackNotice>;
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
      <div>
        <Button onClick={() => submit(mission)} disabled={!selected || submitting}>
          {submitting ? 'Submitting…' : 'Submit answer'}
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

function BackNotice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <h1 className="text-xl font-bold">{title}</h1>
      <Muted className="mt-2">{children}</Muted>
      <div className="mt-4">
        <Link href="/week">
          <Button variant="ghost">Back to this week</Button>
        </Link>
      </div>
    </Card>
  );
}
