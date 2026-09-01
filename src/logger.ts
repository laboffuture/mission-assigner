import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';

/**
 * Structured JSON logging (Item 2).
 *
 * One pino logger for the whole app. Level from LOG_LEVEL (default 'info').
 * Secrets and answer content are redacted explicitly (see REDACT_PATHS) so they
 * can never reach the logs. When ENABLE_TEST_HOOKS is set, logs are ALSO copied
 * into an in-memory ring buffer so the logging test can assert on them without
 * scraping files.
 */

const LEVEL = process.env.LOG_LEVEL ?? 'info';
const TEST_HOOKS = !!process.env.ENABLE_TEST_HOOKS;

/**
 * Explicit redaction. Never log API keys, tokens, passwords, cookies, or the
 * answer content of a submission/feedback. Redaction happens at serialization,
 * so it applies to every destination (stdout and the test ring buffer).
 */
const REDACT_PATHS = [
  // request/response headers that can carry credentials
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  // generic secret-ish keys anywhere one level deep
  'password',
  '*.password',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'SENTRY_DSN',
  // answer content — never log what the student chose or the mission key
  'answer_key',
  '*.answer_key',
  'answer_value',
  '*.answer_value',
  'req.body.selected',
  'req.body.answers',
];

// In-memory ring buffer (test hooks only).
const ring: any[] = [];
const RING_MAX = 1000;
function pushLine(line: string) {
  const t = line.trim();
  if (!t) return;
  try {
    ring.push(JSON.parse(t));
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  } catch {
    /* ignore non-JSON lines */
  }
}
class RingStream extends Writable {
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    for (const l of chunk.toString().split('\n')) pushLine(l);
    cb();
  }
}

const baseOptions: pino.LoggerOptions = {
  level: LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  serializers: { err: pino.stdSerializers.err },
};

export const logger: pino.Logger = TEST_HOOKS
  ? pino(baseOptions, pino.multistream([{ stream: process.stdout }, { stream: new RingStream() }]))
  : pino(baseOptions, process.stdout);

/** Recent log entries (test hooks only). Optionally filtered by requestId. */
export function getTestLogs(requestId?: string): any[] {
  if (!requestId) return ring.slice(-200);
  return ring.filter((e) => e && e.requestId === requestId);
}

/** A fresh request id (used when the client does not supply X-Request-Id). */
export function newRequestId(): string {
  return randomUUID();
}
