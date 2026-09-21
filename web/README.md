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

## Theming — the LOF LMS tokens

The visual theme is the LMS's own. Three files, loaded in this order by
`app/layout.tsx`:

| file                        | owner            | contents                                                                           |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `styles/lof-lms-tokens.css` | **LOF LMS team** | Their token file, byte-identical. Never edit it.                                   |
| `styles/tokens.css`         | us               | Semantic aliases (`--color-surface: var(--nebula-bg-card)`). No values of its own. |
| `app/globals.css`           | us               | Preflight-compat layer + focus ring + `.sr-only`.                                  |

Because our layer aliases rather than copies, a replacement token file from the
LMS re-skins the whole UI with no edits on our side — which is what section 8 of
their guide asks for ("if the LMS palette changes we send a new file and your
tool updates with it").

**Dark is the default.** Nebula (dark) is defined on `:root`; Horizon (light)
applies when the root element carries `data-lof-theme="horizon"`. A missing theme
means dark, which is their specified safe default.

### Why Tailwind is still here, and why it does not fight the tokens

Section 9 of the style guide asks tools not to "load a second UI framework such
as Bootstrap or Tailwind only for styling. It will fight these tokens and make
the tool look different."

We kept Tailwind — removing it means rewriting every component — but configured
it so **it emits nothing of its own**. It is now shorthand for their tokens:

1. **Preflight is off** (`corePlugins: { preflight: false }`), so their base
   styles on `body`, headings, links and inputs are the ones that apply.
2. **`theme.colors` is replaced, not extended.** Tailwind's palette is gone —
   `bg-blue-500` no longer compiles to anything. Every colour resolves to a
   `var(--nebula-*)` / `var(--lof-*)`.
3. **Spacing, radius and fonts** likewise replace the defaults and resolve to
   `--lof-space-*`, `--lof-radius-*` and `--lof-font-*`.

Verified by inspecting the compiled bundle: no default-palette class is present,
and every padding/radius/font value is a `var(--lof-*)`. `npm run check:tokens`
fails the build on a raw hex **or** a Tailwind default-palette class name, so a
`bg-slate-800` that would silently produce nothing is caught instead.

Two notes for a reviewer:

- **The preflight-compat layer is not optional.** Tailwind's `border-*` utilities
  set border-_width_ only and rely on preflight for the global
  `border-style: solid`. Without it all ~100 border utilities in this app render
  nothing at all. `globals.css` restores that and the few other preflight
  behaviours our markup depends on — inside `@layer base`, which matters: the
  button reset's `[type='submit']` selector has the same specificity (0,1,0) as a
  utility class, so outside the base layer it beats `bg-primary` on source order
  and every submit button loses its background.
- **Spacing is aliased, not re-scaled.** Their six-step scale is available
  directly (`p-md`, `gap-lg`), and the numeric utilities already in the codebase
  (`p-4`, `gap-3`, 222 of them) are aliased onto the nearest LOF step rather than
  rewritten. Every emitted value is one of their tokens; differences are 1–3px.

### Fonts

Their token file `@import`s Sora, Inter and Space Mono from Google Fonts. Their
guide states the `<head>` link is **preferred** over the `@import` ("Add the same
line to your `<head>` (preferred), or keep the `@import` below"), because an
`@import` blocks rendering. We left their file byte-identical so it stays a
drop-in replacement, and load the same families through Next's font handling.
Worth confirming with the LMS team whether they would accept a token file without
the `@import` line, which would remove the duplicate request.

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
point — either we adjust _our usage_ (which token sits on which background) or we
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

### Every student journey runs across student ids of every length

The session cookie is a signed base64 JSON payload, and whether its base64 ends
in `=` padding depends on how many digits the student's id has. The server-side
API client once rebuilt the Cookie header through Next's `cookies().toString()`,
which percent-encodes each value — turning that `=` into `%3D`, breaking the
signature, and bouncing every student with an id of the "wrong" length to
`/login`. It went unnoticed because the seed only created ids 1–9, which all fell
on the same side.

`lib/api/server.ts` now forwards the incoming Cookie header **raw** from
`headers()`. So this cannot hide again, the seed creates students at ids 10, 99,
100, 999, 1000, 9999, 10000 and 100000 (`BOUNDARY_IDS` in `e2e/helpers.ts`), and
every student journey spec runs for its original student and then for each of
them. The full week → mission → result → feedback → progress flow for ids 10 and
10000 is `student-flow.spec.ts` `[student 10]` and `[student 10000]`.
