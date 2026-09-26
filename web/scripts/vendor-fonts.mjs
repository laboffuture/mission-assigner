// Vendor the three LMS font families into the repo, once.
//
// next/font/google self-hosts the files at RUNTIME but downloads them at BUILD
// time, so `docker compose build` could fail because fonts.googleapis.com was
// unreachable — and it did, once, on a CI stack build. A deploy to our own server
// must not depend on Google being up, so the files live here instead and
// next/font/local serves them.
//
// Re-run this only to update a family (`node scripts/vendor-fonts.mjs`), and
// commit whatever it writes. Nothing in the build or the test suite runs it.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'fonts');

// The same three families, weights and subset the layout asked next/font for.
const FAMILIES = [
  { spec: 'Sora:wght@400..800', file: (i) => `sora-latin-variable.woff2`, expect: 1 },
  { spec: 'Inter:wght@300..700', file: (i) => `inter-latin-variable.woff2`, expect: 1 },
  { spec: 'Space+Mono:wght@400;700', file: (i) => `space-mono-latin-${[400, 700][i]}.woff2`, expect: 2 },
];

// Google serves woff2 only to browsers that ask like one.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

mkdirSync(OUT, { recursive: true });

for (const family of FAMILIES) {
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?family=${family.spec}&display=swap`, {
      headers: { 'User-Agent': UA },
    })
  ).text();

  // Only the `latin` blocks: latin-ext, cyrillic and the rest are weight we do
  // not serve. The comment before each block names its subset.
  const latin = css
    .split('/*')
    .filter((block) => block.trimStart().startsWith('latin */'))
    .map((block) => /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1])
    .filter(Boolean);

  if (latin.length !== family.expect) {
    throw new Error(`${family.spec}: expected ${family.expect} latin file(s), found ${latin.length}`);
  }

  for (const [i, url] of latin.entries()) {
    const name = family.file(i);
    const bytes = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
    if (bytes.length < 5_000) throw new Error(`${name}: suspiciously small (${bytes.length} bytes)`);
    writeFileSync(join(OUT, name), bytes);
    console.log(`  ${name.padEnd(30)} ${(bytes.length / 1024).toFixed(0)} KB  <- ${url.slice(0, 60)}…`);
  }
}

console.log(`\nwritten to ${OUT}`);
if (!existsSync(join(OUT, 'sora-latin-variable.woff2'))) process.exitCode = 1;
