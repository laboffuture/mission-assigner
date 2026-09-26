// The build must not depend on Google being reachable.
//
// next/font/google self-hosts at runtime but DOWNLOADS at build time, so a
// single import of it puts fonts.googleapis.com on the critical path of
// `docker compose build` — a deploy to our own server then fails when Google is
// unreachable, which happened once in CI. The families are vendored in
// app/fonts/ and loaded with next/font/local instead.
//
// This looks for USAGE, not mentions: an import of next/font/google, an @import
// of a Google stylesheet, or a url() pointing at gstatic. Naming those in a
// comment (this file does, and so does the layout) explains the rule rather
// than breaking it.
//
// Run: npm run check:fonts   (CI runs it in the web job)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.next', 'test-results', 'playwright-report', '.turbo', 'scripts']);
const FONT_DIR = join(web, 'app', 'fonts');

// The LMS's own stylesheet is kept byte-identical on purpose and is NOT shipped:
// scripts/generate-lms-tokens.mjs writes the copy that is, with the Google
// @import removed. That generated copy is checked below, which is the one that
// matters.
const PRISTINE_VENDOR_FILE = join('styles', 'lof-lms-tokens.css');
const GENERATED_TOKENS = join(web, 'styles', 'generated', 'lof-lms-tokens.css');

const USAGES = [
  {
    re: /(?:from|require\(|import\()\s*['"]next\/font\/google['"]/,
    why: 'imports next/font/google, which downloads from Google at build time — use next/font/local with a file in app/fonts/',
  },
  {
    re: /@import[^;]*fonts\.googleapis\.com/,
    why: 'imports a Google stylesheet, which every visitor fetches and which blocks the first paint',
  },
  { re: /url\(\s*['"]?https?:\/\/fonts\.gstatic\.com/, why: 'fetches font files from Google at runtime' },
];

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.(ts|tsx|js|jsx|mjs|css)$/.test(entry.name)) yield full;
  }
}

let bad = 0;
const fail = (where, why) => {
  console.log(`  BAD  ${where}: ${why}`);
  bad++;
};

for (const file of sources(web)) {
  const rel = file.slice(web.length + 1);
  if (rel === PRISTINE_VENDOR_FILE) continue;
  const text = readFileSync(file, 'utf8');
  for (const { re, why } of USAGES) if (re.test(text)) fail(rel.split(sep).join('/'), why);
}

// The generated stylesheet is the one that ships; it must have had the Google
// @import stripped.
try {
  const generated = readFileSync(GENERATED_TOKENS, 'utf8');
  if (/fonts\.googleapis\.com/.test(generated)) {
    fail('styles/generated/lof-lms-tokens.css', 'still carries the LMS file’s Google @import — regenerate it');
  }
} catch {
  fail('styles/generated/lof-lms-tokens.css', 'missing — run the token generator');
}

const vendored = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2'));
if (vendored.length === 0) fail('app/fonts/', 'no .woff2 files — the vendored fonts are missing');
for (const f of vendored) {
  const size = statSync(join(FONT_DIR, f)).size;
  if (size < 5_000) fail(`app/fonts/${f}`, `${size} bytes — that is not a real font file`);
}

if (bad) {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Fonts::${bad} place(s) make the build or the page depend on Google`);
  }
  console.log(`\n==== Fonts: ${bad} problem(s) ====`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${vendored.length} vendored font files; nothing in web/ fetches from Google`);
}
