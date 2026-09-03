# Mission Hub — student web UI

Next.js 14 (App Router) student surface, **same-origin** with the Express API
(`next.config.mjs` rewrites `/api/*` → `API_ORIGIN`, no CORS). Dev on `:3001`,
API on `:3000`.

## Run

```
npm install
npm run dev            # :3001 — expects the API on :3000
```

The API must be running (`ENABLE_TEST_HOOKS=1 npm run dev` in `..`) and MySQL up.
Students enter via the dev launch at `/login`, which calls `/api/dev/login-as`
(the same session path the Moodle LTI launch will use).

## Theming — one file

`styles/tokens.css` is the **single source of truth** for colour, font and size,
and the only file allowed to contain a raw hex/rgb/font value. `tailwind.config.ts`
maps semantic names (`bg-surface`, `text-muted`, `rounded-lg`, `ring-focus`, …)
onto those CSS variables; components use only the semantic names.

Enforced by `npm run check:tokens` — it fails if any component under `app/` or
`components/` contains a raw value. Re-skinning for the LMS is an edit to
`tokens.css` alone.

## Accessibility

The student surface is used by minors, so accessibility is a requirement, not a
polish pass. What's in place:

- **Radiogroups** — feedback answers and the 1–5 scale are native `<input
  type=radio>` groups (arrow-key navigation, focus and SR semantics from the
  platform), with scale endpoint anchors ("Low"/"High" and "1, lowest"/"5,
  highest" in the accessible name).
- **Keyboard-complete** — a mission and feedback can be finished with the keyboard
  alone (covered by `e2e/keyboard.spec.ts`). Global `:focus-visible` ring on every
  interactive element; a "Skip to content" link; `prefers-reduced-motion` honoured.
- **Screen-reader labels** — mission options carry `Option A: …` names; week-slot
  tiles announce their state; locked slots announce "Locked. …"; progress numbers
  read as "Level 3", not "3 Level".
- **Never colour alone** — done/open/coming on the week board and correct/incorrect
  on the result screen each carry a glyph (✓ ▶ 🔒 / ✓ ✗) and a word in addition to
  colour, for colour-vision-deficient students.
- **axe-core** runs over all five screens plus the mission-answering and result
  states in `e2e/a11y.spec.ts` (WCAG 2.1 A/AA, including colour contrast).

### Colour contrast — and the LMS handover

Contrast currently passes WCAG AA (4.5:1 small text) against the **placeholder**
token values in `tokens.css`, verified by the axe checks. The semantic text
colours were darkened so same-hue text on a `*-muted` background (e.g. a success
badge) clears the threshold.

**The real check happens when the LMS palette lands.** Re-run `npm run e2e` after
swapping the token values: if a token pair then fails contrast, that's a decision
point — either we adjust *our usage* (which token sits on which background) or we
raise the specific pair with the LMS team as a palette problem. The axe suite is
what surfaces it.

## Tests

```
npm run typecheck
npm run check:tokens
npm run e2e           # Playwright — expects the full stack up (API + MySQL + Next)
```

`e2e/` covers the student flow (week → mission → result → feedback → progress),
empty states, submit resilience (network-drop retry with a reused
Idempotency-Key; session-expiry redirect), keyboard-only completion, and the
axe accessibility scans. Specs reseed the DB per file and are scoped to CommonJS
(`e2e/package.json`) to avoid the Playwright ESM race.
