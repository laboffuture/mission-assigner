// Guard: component files must reference ONLY semantic token classes — never a
// raw color, rgb/hsl, or font-family value. Those live solely in
// styles/tokens.css. Fails (exit 1) if any component contains a raw value, so a
// grep for a hex code in the components finds nothing.
//
// Scanned: app/**/*.{ts,tsx}, components/**/*.{ts,tsx}.
// Exempt:  styles/** (tokens), *.css (base styles reference vars by design).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DIRS = ['app', 'components'];
const EXATS = new Set(['.ts', '.tsx']);

// Tailwind's own palette. Section 9 of the LOF style guide asks us not to let a
// second framework's styling fight their tokens, so tailwind.config.ts REPLACES
// theme.colors and these no longer compile at all. They would therefore fail
// silently — the class name stays in the markup and simply produces nothing.
// Catching them here turns that silence into a build failure.
const TW_PALETTE =
  'slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const TW_PREFIX =
  'bg|text|border|ring|ring-offset|from|to|via|divide|outline|shadow|accent|caret|decoration|fill|stroke|placeholder';

const PATTERNS = [
  { name: 'hex color', re: /#[0-9a-fA-F]{3,8}\b/ },
  { name: 'rgb()/rgba()', re: /\brgba?\s*\(/ },
  { name: 'hsl()/hsla()', re: /\bhsla?\s*\(/ },
  { name: 'font-family', re: /font-family/i },
  {
    name: 'Tailwind default palette',
    re: new RegExp(`\\b(?:${TW_PREFIX})-(?:${TW_PALETTE})-(?:50|100|200|300|400|500|600|700|800|900|950)\\b`),
  },
  {
    // bg-white / text-black etc. Section 9: "Do not use pure black (#000) or
    // pure white (#FFF) as a background. Use the background variables instead."
    name: 'Tailwind black/white',
    re: /\b(?:bg|text|border|ring|divide|placeholder)-(?:black|white)\b/,
  },
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXATS.has(extname(p))) out.push(p);
  }
  return out;
}

const violations = [];
for (const d of DIRS) {
  for (const file of walk(join(root, d))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { name, re } of PATTERNS) {
        if (re.test(line)) {
          violations.push(`  ${file.slice(root.length + 1)}:${i + 1}  [${name}]  ${line.trim()}`);
        }
      }
    });
  }
}

if (violations.length) {
  console.error('FAIL: raw style values found in component files (use token classes instead):\n');
  console.error(violations.join('\n'));
  console.error(`\n${violations.length} violation(s). Define values in styles/tokens.css and map them in tailwind.config.ts.`);
  process.exit(1);
}
console.log('OK: no raw color/font values in components — token classes only.');
