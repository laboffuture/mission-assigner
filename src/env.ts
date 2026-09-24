import { z } from 'zod';

/**
 * Startup configuration validation (Item 6 / review Item 17).
 *
 * Every environment variable the app reads is declared here and validated on
 * boot. If anything required is missing or malformed the process refuses to
 * start and prints exactly which variable is wrong — the app never runs
 * half-configured. Unknown env vars (PATH, etc.) are ignored.
 */
/**
 * Secrets that must be real in production. Kept next to the check so adding a
 * secret to .env.production.example and forgetting this list is hard to do.
 */
const SECRET_VARS = ['SESSION_SECRET', 'DB_PASS', 'SEED_STAFF_PASSWORD', 'BACKUP_S3_SECRET_KEY'] as const;

/**
 * The shapes a copied template leaves behind: the words used in
 * .env.production.example, the classic defaults, and "same value repeated".
 */
function looksLikePlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  // Template markers: <set-on-host>, replace-me, your-key, TODO, …
  if (/<[^>]*>/.test(v)) return true;
  if (/(^|[^a-z])(replace|change|set)[-_ ]?(me|on[-_ ]host)/.test(v)) return true;
  if (/(placeholder|example|your[-_ ]|todo)/.test(v)) return true;
  // Shipped defaults. Deliberately exact matches, not substrings: a real secret
  // may contain any of these as a fragment, and a check that cries wolf gets
  // turned off. ('xxx' was matched loosely here and flagged a test fixture of
  // repeated characters — the kind of false positive that does exactly that.)
  return ['changeme', 'password', 'devpass', 'secret', 'notset', 'unset'].includes(v);
}

const EnvSchema = z
  .object({
    DB_HOST: z.string().min(1).default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
    // Proxy hops in front of this process (Caddy = 1). Needed for Secure
    // cookies behind TLS termination; see the comment in server.ts.
    TRUST_PROXY: z.string().optional(),
    DB_USER: z.string().min(1).default('root'),
    DB_PASS: z.string().default(''),
    DB_NAME: z.string().min(1).default('mission_demo'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // No schema default: outside production an unset AUTH_MODE means dev (see
    // auth.ts), but in production it must be set explicitly — and not to dev.
    AUTH_MODE: z.enum(['dev', 'lti']).optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Signs the staff session cookie. Required in production (min 32 chars); a
    // known dev value is used otherwise so local runs work out of the box.
    SESSION_SECRET: z.string().optional(),
    // SameSite policy for the session cookie. 'lax' (default) suits the current
    // top-level staff login. The LTI launch is a cross-site POST and Moodle
    // usually embeds the tool in an iframe, both of which require 'none' (which
    // forces Secure/HTTPS) — see the Session cookie section in the README.
    SESSION_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    // Absolute session lifetime in SECONDS, enforced on the server from the
    // issue time stored inside the signed session — the cookie's own expiry is a
    // browser hint, not a security control. Default 12 hours.
    SESSION_MAX_AGE: z.coerce.number().int().positive().default(43200),
    // Double-submit CSRF enforcement. Default false while the session cookie is
    // SameSite=Lax (which already blocks cross-site POSTs). Flip to true in the
    // same change that sets SESSION_SAMESITE=none for the LTI launch.
    CSRF_ENFORCED: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    COLD_START_STRATEGY: z.enum(['SEGMENT_START', 'PLACEMENT']).default('SEGMENT_START'),
    FEEDBACK_GATES_UNLOCK: z.string().optional(),
    // Curriculum selection (see src/config.ts).
    // Declares how many api processes are meant to run. The enforcement is not
    // here: src/singleInstance.ts claims the database with a MySQL named lock,
    // because neither `--scale api=2` nor a redeploy that leaves the old
    // container running changes this value.
    INSTANCE_COUNT: z.coerce.number().int().positive().default(1),
    SELECTION_MODE: z.enum(['legacy', 'curriculum']).default('legacy'),
    POOL_LOOKBACK_SESSIONS: z.coerce.number().int().min(0).default(0),
    PERCENT_SCOPE: z.enum(['credit', 'project', 'track']).default('credit'),
    REVISION_MIX_PERCENT: z.coerce.number().int().min(0).max(100).default(20),
    // Local MySQL install (no Docker): mysqldump path used by verify:migrations.
    MYSQLDUMP: z.string().optional(),
    SENTRY_DSN: z.union([z.string().url(), z.literal('')]).optional(),
    ENABLE_TEST_HOOKS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Production FAILS CLOSED: every insecure fallback is a refusal to boot, not
    // a warning. Each check names the variable and why.

    // A weak/absent session secret is fine locally but never in production.
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'must be set to a random string of at least 32 characters when NODE_ENV=production',
      });
    }
    // Dev auth trusts a client-supplied X-User-Id header: anyone could act as
    // anyone. It must never be reachable in production, including by omission.
    if (env.AUTH_MODE === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_MODE'],
        message:
          'must be set explicitly when NODE_ENV=production (AUTH_MODE=lti). It is unset, and unset means dev auth, which trusts a client-supplied X-User-Id header',
      });
    } else if (env.AUTH_MODE === 'dev') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_MODE'],
        message:
          'AUTH_MODE=dev is not allowed when NODE_ENV=production: it trusts a client-supplied X-User-Id header. Use AUTH_MODE=lti',
      });
    }
    // Behind a TLS-terminating proxy the app sees plain HTTP, and cookie-session
    // then refuses to set the Secure session cookie — silently, so every student
    // simply fails to sign in. Production must therefore SAY which it is:
    // TRUST_PROXY=1 behind a proxy (the compose stack), or TRUST_PROXY=0 when
    // this process terminates TLS itself. Unset is not a safe default either
    // way, so it is a refusal rather than a guess.
    if (env.TRUST_PROXY === undefined || env.TRUST_PROXY === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY'],
        message:
          'must be set explicitly when NODE_ENV=production: TRUST_PROXY=1 if a reverse proxy terminates TLS ' +
          '(the infra/ compose stack does), or TRUST_PROXY=0 if this process terminates TLS itself. ' +
          'Unset means the Secure session cookie is never set behind a proxy and nobody can sign in',
      });
    }
    // A secret still holding its example value means .env.production.example was
    // copied and not filled in. That is not a typo to discover later, when a
    // forged session cookie works: refuse, and name the variable.
    for (const name of SECRET_VARS) {
      const value = (env as Record<string, unknown>)[name];
      if (typeof value === 'string' && value && looksLikePlaceholder(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message:
            `still holds an example placeholder value. Set a real secret on the host ` +
            `(see infra/README.md); .env.production.example is a template, never a source of secrets`,
        });
      }
    }
    // Test hooks reconfigure the running server (gating, selection mode,
    // rate-limit reset, log dump). No production configuration may expose them.
    if (env.ENABLE_TEST_HOOKS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENABLE_TEST_HOOKS'],
        message:
          'must not be set when NODE_ENV=production: it exposes /api/test/* (runtime reconfiguration and log access)',
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
