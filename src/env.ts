import { z } from 'zod';

/**
 * Startup configuration validation (Item 6 / review Item 17).
 *
 * Every environment variable the app reads is declared here and validated on
 * boot. If anything required is missing or malformed the process refuses to
 * start and prints exactly which variable is wrong — the app never runs
 * half-configured. Unknown env vars (PATH, etc.) are ignored.
 */
const EnvSchema = z
  .object({
    DB_HOST: z.string().min(1).default('127.0.0.1'),
    DB_USER: z.string().min(1).default('root'),
    DB_PASS: z.string().default(''),
    DB_NAME: z.string().min(1).default('mission_demo'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    AUTH_MODE: z.enum(['dev', 'lti']).default('dev'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Signs the staff session cookie. Required in production (min 32 chars); a
    // known dev value is used otherwise so local runs work out of the box.
    SESSION_SECRET: z.string().optional(),
    // SameSite policy for the session cookie. 'lax' (default) suits the current
    // top-level staff login. The LTI launch is a cross-site POST and Moodle
    // usually embeds the tool in an iframe, both of which require 'none' (which
    // forces Secure/HTTPS) — see the Session cookie section in the README.
    SESSION_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    COLD_START_STRATEGY: z.enum(['SEGMENT_START', 'PLACEMENT']).default('SEGMENT_START'),
    FEEDBACK_GATES_UNLOCK: z.string().optional(),
    SENTRY_DSN: z.union([z.string().url(), z.literal('')]).optional(),
    ENABLE_TEST_HOOKS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // A weak/absent session secret is fine locally but never in production.
    if (env.NODE_ENV === 'production' && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'must be set to a random string of at least 32 characters when NODE_ENV=production',
      });
    }
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
