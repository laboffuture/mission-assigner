// The LMS token file, minus its Google Fonts @import — generated, never edited.
//
// styles/lof-lms-tokens.css is THEIRS and stays byte-identical to what they
// sent (their header: "Do not edit these values"). But its `@import
// url(fonts.googleapis.com…)` is render-blocking: the browser cannot paint
// until that request completes, and it ships our students' IPs to Google on
// every load. Their own comment offers the alternative ("Add the same line to
// your <head> (preferred)"), and the Next way to do that is next/font, which
// self-hosts the same three families and preloads them (app/layout.tsx).
//
// So: this script copies their file with that ONE line removed, and the app
// imports the copy. Nothing else is touched — if the removed line is not
// exactly the expected @import, it fails rather than silently dropping
// something else, and any other change they send flows straight through.
//
// Run: npm run gen:tokens  (also runs from predev/prebuild and check:tokens)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(root, 'styles', 'lof-lms-tokens.css');
const OUT = join(root, 'styles', 'generated', 'lof-lms-tokens.css');
const FONT_IMPORT = /^@import url\('https:\/\/fonts\.googleapis\.com\/[^']*'\);$/;

export function generate() {
  const source = readFileSync(SOURCE, 'utf8');
  const lines = source.split(/\r?\n/);
  const hits = lines.filter((l) => FONT_IMPORT.test(l.trim()));
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one Google Fonts @import in styles/lof-lms-tokens.css, found ${hits.length}. ` +
        `Their file changed shape — check it before regenerating.`
    );
  }
  const header =
    `/* GENERATED — do not edit. Source: styles/lof-lms-tokens.css (theirs, unmodified).\n` +
    `   Only difference: the Google Fonts @import is removed; app/layout.tsx loads the\n` +
    `   same three families with next/font. Regenerate: npm run gen:tokens  */\n`;
  const body = lines.filter((l) => !FONT_IMPORT.test(l.trim())).join('\n');
  mkdirSync(dirname(OUT), { recursive: true });
  return { content: header + body, out: OUT };
}

const { content, out } = generate();
if (process.argv.includes('--check')) {
  const current = (() => {
    try {
      return readFileSync(out, 'utf8');
    } catch {
      return null;
    }
  })();
  if (current !== content) {
    console.error('styles/generated/lof-lms-tokens.css is out of date — run: npm run gen:tokens');
    process.exit(1);
  }
  console.log('generated LMS token file is current');
} else {
  writeFileSync(out, content);
  console.log(`wrote ${out.slice(root.length + 1)}`);
}
