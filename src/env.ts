import { z } from 'zod';

/**
 * Startup configuration validation (Item 6 / review Item 17).
 *
 * Every environment variable the app reads is declared here and validated on
 * boot. If anything required is missing or malformed the process refuses to
 * start and prints exactly which variable is wrong — the app never runs
 * half-configured. Unknown env vars (PATH, etc.) are ignored.
 */
const EnvSchema = z.object({
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_USER: z.string().min(1).default('root'),
  DB_PASS: z.string().default(''),
  DB_NAME: z.string().min(1).default('mission_demo'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  AUTH_MODE: z.enum(['dev', 'lti']).default('dev'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  COLD_START_STRATEGY: z.enum(['SEGMENT_START', 'PLACEMENT']).default('SEGMENT_START'),
  FEEDBACK_GATES_UNLOCK: z.string().optional(),
  SENTRY_DSN: z.union([z.string().url(), z.literal('')]).optional(),
  ENABLE_TEST_HOOKS: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Validate process.env. Exits the process with a clear, per-variable message on
 * failure. Uses process.stderr directly (not the logger) so it works even if the
 * logging config itself is the thing that is malformed.
 */
export function validateEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    process.stderr.write(
      `\nFATAL: invalid environment configuration — refusing to start.\n` +
        `${issues}\n\n` +
        `See .env.example for the variables the app needs.\n`
    );
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
