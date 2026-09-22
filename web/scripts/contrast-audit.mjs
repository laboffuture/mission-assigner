// Contrast ratios for the colour pairs this app puts on screen, in both themes.
//
// Reads the palette straight out of styles/lof-lms-tokens.css (their file), so
// the numbers are theirs, not ours, and stay correct when they send a new one.
// Two jobs:
//   1. tell OUR usage mistakes (a token we chose badly) apart from pairs the LMS
//      palette cannot satisfy at all — we fix the first and report the second;
//   2. cover what axe cannot evaluate, above all text on a GRADIENT: axe skips
//      gradients entirely, so white on the primary gradient is measured here
//      against each end of the gradient.
//
// Run: npm run report:contrast          (prints the table)
//      npm run report:contrast -- --md  (markdown, for docs/lms-contrast-findings.md)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, 'styles', 'lof-lms-tokens.css'), 'utf8');

/** Their file declares nebula on :root and horizon under [data-lof-theme="horizon"]. */
function paletteFor(theme) {
  const block =
    theme === 'nebula'
      ? css.slice(css.indexOf(':root {'), css.indexOf('[data-lof-theme="horizon"]'))
      : css.slice(css.indexOf('[data-lof-theme="horizon"]'));
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  if (theme === 'horizon') {
    // Horizon re-declares only what changes; the rest stays as declared on :root.
    const base = paletteFor('nebula');
    return { ...base, ...out };
  }
  return out;
}

const hexToRgb = (h) => {
  const s = h.replace('#', '');
  const n = s.length === 3 ? [...s].map((c) => c + c) : [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
  return n.map((x) => parseInt(x, 16));
};
const parseColor = (value, palette) => {
  const v = String(value).trim();
  const varRef = v.match(/^var\((--[\w-]+)\)$/);
  if (varRef) return parseColor(palette[varRef[1]], palette);
  // A bare token name, as the pair table writes it.
  if (v.startsWith('--')) return parseColor(palette[v], palette);
  if (v.startsWith('#')) return { rgb: hexToRgb(v), alpha: 1 };
  const rgba = v.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(',').map((x) => parseFloat(x.trim()));
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
};
/** Flatten a translucent colour onto its backdrop — what the eye actually sees. */
const over = (fg, bg) => fg.rgb.map((c, i) => Math.round(c * fg.alpha + bg.rgb[i] * (1 - fg.alpha)));
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function ratio(fgValue, bgValue, palette, backdropValue) {
  const backdrop = backdropValue ? parseColor(backdropValue, palette) : { rgb: [0, 0, 0], alpha: 1 };
  let bg = parseColor(bgValue, palette);
  if (!bg) return null;
  if (bg.alpha < 1) bg = { rgb: over(bg, backdrop), alpha: 1 };
  let fg = parseColor(fgValue, palette);
  if (!fg) return null;
  if (fg.alpha < 1) fg = { rgb: over(fg, bg), alpha: 1 };
  const [a, b] = [luminance(fg.rgb), luminance(bg.rgb)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** Gradient ends, so text on a gradient is judged against its worst end. */
const gradientEnds = (value, palette) => {
  const stops = [...String(value).matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0]);
  return stops.map((s) => ({ stop: s, color: s, palette }));
};

// Every foreground/background pair the app renders, named as a student would
// meet it. `need` is the WCAG 2.1 AA threshold for that text size/role.
const PAIRS = [
  ['Body text on the page', '--nebula-text-secondary', '--nebula-bg-primary', 4.5],
  ['Body text on a card', '--nebula-text-secondary', '--nebula-bg-card', 4.5],
  ['Headings on a card', '--nebula-text-primary', '--nebula-bg-card', 4.5],
  ['Muted label on a card', '--nebula-text-muted', '--nebula-bg-card', 4.5],
  ['Muted label on the page', '--nebula-text-muted', '--nebula-bg-primary', 4.5],
  ['Link / brand colour on a card', '--lof-primary', '--nebula-bg-card', 4.5],
  ['Link colour (light) on a card', '--lof-primary-light', '--nebula-bg-card', 4.5],
  ['Success colour as text on a card', '--nebula-green', '--nebula-bg-card', 4.5],
  ['Danger colour as text on a card', '--nebula-red', '--nebula-bg-card', 4.5],
  ['Warning colour as text on a card', '--nebula-amber', '--nebula-bg-card', 4.5],
  ['Success text on its 15% tint', '--nebula-green', 'rgba(34,197,94,0.15)', 4.5, '--nebula-bg-card'],
  ['Danger text on its 15% tint', '--nebula-red', 'rgba(239,68,68,0.15)', 4.5, '--nebula-bg-card'],
  ['Warning text on its 15% tint', '--nebula-amber', 'rgba(245,158,11,0.15)', 4.5, '--nebula-bg-card'],
  ['Primary text on its glow tint', '--lof-primary-light', '--lof-primary-glow', 4.5, '--nebula-bg-card'],
  ['White on the solid danger colour (their .lof-btn--danger)', '#FFFFFF', '--nebula-red', 4.5],
  ['White on the solid primary colour', '#FFFFFF', '--lof-primary', 4.5],
  ['Page text colour on the solid primary colour', '--nebula-text-primary', '--lof-primary', 4.5],
  ['Page text colour on the solid danger colour', '--nebula-text-primary', '--nebula-red', 4.5],
  [
    'Page text colour on a 15% status tint (our chips)',
    '--nebula-text-primary',
    'rgba(34,197,94,0.15)',
    4.5,
    '--nebula-bg-card',
  ],
  ['Secondary text on a 15% status tint', '--nebula-text-secondary', 'rgba(239,68,68,0.15)', 4.5, '--nebula-bg-card'],
  ['Card border against the card', '--nebula-border', '--nebula-bg-card', 3.0, '--nebula-bg-card'],
];

const themes = ['nebula', 'horizon'];
const rows = [];
for (const [label, fg, bg, need, backdrop] of PAIRS) {
  const cells = themes.map((t) => {
    const p = paletteFor(t);
    const r = ratio(fg, bg, p, backdrop);
    return r == null ? null : { r, pass: r >= need };
  });
  rows.push({ label, need, cells });
}
// The gradient: axe cannot evaluate it at all, so it is measured here by hand.
for (const t of themes) {
  const p = paletteFor(t);
  for (const end of gradientEnds(p['--nebula-gradient-primary'], p)) {
    const r = ratio('#FFFFFF', end.color, p);
    rows.push({
      label: `White on the primary gradient (${t} end ${end.stop}) — axe cannot see gradients`,
      need: 4.5,
      cells: themes.map((x) => (x === t ? { r, pass: r >= 4.5 } : null)),
    });
  }
}

const fmt = (c) => (c == null ? '—' : `${c.r.toFixed(2)}:1 ${c.pass ? 'PASS' : 'FAIL'}`);
if (process.argv.includes('--md')) {
  console.log('| Pair | Needs | Nebula | Horizon |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.label} | ${r.need}:1 | ${fmt(r.cells[0])} | ${fmt(r.cells[1])} |`);
} else {
  const w = Math.max(...rows.map((r) => r.label.length));
  console.log(`${'Pair'.padEnd(w)}  needs   nebula            horizon`);
  for (const r of rows) {
    console.log(`${r.label.padEnd(w)}  ${String(r.need).padEnd(6)} ${fmt(r.cells[0]).padEnd(17)} ${fmt(r.cells[1])}`);
  }
  const failures = rows.filter((r) => r.cells.some((c) => c && !c.pass)).length;
  console.log(`\n${failures} of ${rows.length} pairs fail AA in at least one theme.`);
}
