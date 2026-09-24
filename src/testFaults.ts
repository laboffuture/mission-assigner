/**
 * Fault injection for the retry path — test-only, and inert unless armed.
 *
 * The failures src/retry.ts exists for (a deadlock, a lock-wait timeout) cannot
 * be produced on demand: they depend on two transactions meeting at the same row
 * at the same moment, which under load is a race a test would sometimes lose. So
 * a test can instead ARM the next submit to fail the way a busy database fails,
 * and then assert what the student sees.
 *
 * Armed only through /api/test/fail-next-submit, which exists solely when
 * ENABLE_TEST_HOOKS is set — and production refuses to boot with that set
 * (src/env.ts). With nothing armed this is one integer comparison per submit.
 */

interface ArmedFault {
  remaining: number;
  code: string;
  errno: number;
}

let armed: ArmedFault | null = null;

const KNOWN: Record<string, number> = {
  ER_LOCK_DEADLOCK: 1213,
  ER_LOCK_WAIT_TIMEOUT: 1205,
  PROTOCOL_CONNECTION_LOST: 0,
};

export function armTransientFault(times: number, code = 'ER_LOCK_DEADLOCK'): void {
  if (times <= 0) {
    armed = null;
    return;
  }
  armed = { remaining: times, code, errno: KNOWN[code] ?? 1213 };
}

/** The next armed failure, if any. Consumes one arming. */
export function takeTransientFault(): Error | null {
  if (!armed) return null;
  armed.remaining -= 1;
  const err = Object.assign(new Error(`injected ${armed.code}`), { code: armed.code, errno: armed.errno });
  if (armed.remaining <= 0) armed = null;
  return err;
}

export function faultsPending(): number {
  return armed?.remaining ?? 0;
}
