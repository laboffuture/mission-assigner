# Colour contrast in the LOF LMS palette — findings for the LMS team

**From:** Mission Hub (LTI tool) · **Palette:** `lof-lms-tokens.css` v1.0, 9 September 2026
**Standard:** WCAG 2.1 AA — 4.5:1 for normal text, 3:1 for large text (≥24px, or ≥18.7px bold)
and for UI components. **Both themes measured:** Nebula (default) and Horizon.

We have **not changed any of your token values**. `styles/lof-lms-tokens.css` is byte-identical
to the file you sent, and our own stylesheet only aliases your variables. Everything below is
therefore either (a) a usage decision we changed on our side, or (b) a property of the palette
that only you can change.

Regenerate these numbers at any time: `npm run report:contrast` (in `web/`). They are computed
from your file, so a new palette re-measures itself.

---

## 1. What we changed on our side

These were our mistakes, not yours, and they are fixed:

| We used to | We now |
|---|---|
| Put `--nebula-text-muted` on card and page backgrounds for labels, dates, captions and slot titles | Use `--nebula-text-secondary` for anything a student reads; `text-muted` is reserved for decoration |
| Use `--lof-primary` for links and small brand-coloured text | Use whichever of **your** two brand tokens passes in that theme: `--lof-primary-light` in Nebula (6.03:1), `--lof-primary` in Horizon (5.70:1) |
| Follow your `.lof-badge--*` pattern (status hue on its own 15% tint) | Keep your tint as the fill and the hue as the border, and put `--nebula-text-primary` on top (12.76:1 / 14.04:1). The hue still carries the meaning, and every badge also says what it is in words |
| Write status messages in `--nebula-red` / `--nebula-green` | Use the page text colour on the tinted panel |

## 2. What only you can fix

Every pair below is your palette's own. We are **not** overriding these, and we have not
weakened our accessibility tests to hide them — we would rather they stay visible.

### 2.1 `--nebula-text-muted` cannot be read on your own surfaces

| Theme | On a card | On the page |
|---|---|---|
| Nebula | **3.82:1** (needs 4.5) | 4.51:1 |
| Horizon | **2.54:1** | **2.43:1** |

Horizon's `#9CA3AF` on `#FFFFFF` is the worst case. Suggested: darken the Horizon muted token
to about `#6B7280` (4.8:1 on white) and the Nebula one to about `#8593B4`.

### 2.2 White on the primary gradient — **3.20:1** (axe cannot detect this)

Automated tools skip gradients entirely: axe-core reports nothing here, in either theme, so this
would never appear in a CI accessibility report. We measured each end of the gradient by hand.

| Gradient | End | White on it |
|---|---|---|
| Nebula `--nebula-gradient-primary` | `#7B4DFF` | 4.83:1 PASS |
| Nebula `--nebula-gradient-primary` | **`#4C8DFF`** | **3.20:1 FAIL** |
| Horizon `--nebula-gradient-primary` | `#7C3AED` | 5.70:1 PASS |
| Horizon `--nebula-gradient-primary` | `#A855F7` | **3.96:1 FAIL** |

Your `.lof-btn--primary` puts `#FFFFFF` on this gradient, so any button label sitting over the
blue end of the Nebula gradient (or the light end of Horizon's) is below AA. Large, bold button
text only needs 3:1 and would pass — but normal-size text on the gradient does not. Suggested:
darken the second stop (e.g. `#3B6FD4` for Nebula, `#8B3FD0` for Horizon), or specify that
gradient buttons use large bold text only.

### 2.3 Your badge pattern fails in at least one theme for every state

`.lof-badge--success|warning|danger` put the status hue on a 15% tint of itself:

| Badge | Nebula | Horizon |
|---|---|---|
| Success | 5.60:1 PASS | **3.31:1 FAIL** |
| Warning | 6.02:1 PASS | **2.84:1 FAIL** |
| Danger | **3.85:1 FAIL** | **3.97:1 FAIL** |
| Primary (`.lof-badge`, glow tint) | **4.08:1 FAIL** | **3.13:1 FAIL** |

Note also that the tints are written as literal `rgba()` of the **Nebula** colours, so a badge in
Horizon keeps a dark-theme fill. Deriving them from the variables — `color-mix(in srgb,
var(--nebula-green) 15%, transparent)` — makes them follow the theme. We do that on our side.

### 2.4 Status colours as text

| As text on a card | Nebula | Horizon |
|---|---|---|
| `--nebula-green` | 7.20:1 PASS | **3.77:1 FAIL** |
| `--nebula-red` | **4.36:1 FAIL** | 4.83:1 PASS |
| `--nebula-amber` | 7.64:1 PASS | **3.19:1 FAIL** |

No single status token is readable in both themes, so a tool cannot write an error message in
your red without failing AA in Nebula.

### 2.5 `.lof-btn--danger` — white on `--nebula-red` is **3.76:1** in Nebula

Your own component rule. Fine in Horizon (4.83:1).

### 2.6 One token missing: text on the brand colour

Your components hardcode `color: #FFFFFF` on the gradient and on solid red. There is no
`--lof-on-primary` / `--lof-on-danger` token, so a tool either copies the hex (which then does
not follow a re-skin) or guesses. We currently derive it per theme from your own tokens
(`--nebula-text-primary` in Nebula, `--nebula-bg-card` in Horizon — both `#FFFFFF`). A named
token would be better for everyone.

### 2.7 Informational — card borders

`--nebula-border` is 1.20:1 (Nebula) / 1.36:1 (Horizon) against the card. This is **not a
failure**: WCAG's 3:1 non-text rule applies to controls and meaningful graphics, and these
borders are decoration. Flagging it only so it is a deliberate choice — a card edge is
invisible to a low-vision student.

---

## 3. Full measured table

| Pair | Needs | Nebula | Horizon |
|---|---|---|---|
| Body text on the page | 4.5:1 | 10.68:1 PASS | 7.24:1 PASS |
| Body text on a card | 4.5:1 | 9.04:1 PASS | 7.56:1 PASS |
| Headings on a card | 4.5:1 | 16.41:1 PASS | 15.99:1 PASS |
| Muted label on a card | 4.5:1 | 3.82:1 FAIL | 2.54:1 FAIL |
| Muted label on the page | 4.5:1 | 4.51:1 PASS | 2.43:1 FAIL |
| Link / brand colour on a card | 4.5:1 | 3.40:1 FAIL | 5.70:1 PASS |
| Link colour (light) on a card | 4.5:1 | 6.03:1 PASS | 4.23:1 FAIL |
| Success colour as text on a card | 4.5:1 | 7.20:1 PASS | 3.77:1 FAIL |
| Danger colour as text on a card | 4.5:1 | 4.36:1 FAIL | 4.83:1 PASS |
| Warning colour as text on a card | 4.5:1 | 7.64:1 PASS | 3.19:1 FAIL |
| Success text on its 15% tint | 4.5:1 | 5.60:1 PASS | 3.31:1 FAIL |
| Danger text on its 15% tint | 4.5:1 | 3.85:1 FAIL | 3.97:1 FAIL |
| Warning text on its 15% tint | 4.5:1 | 6.02:1 PASS | 2.84:1 FAIL |
| Primary text on its glow tint | 4.5:1 | 4.08:1 FAIL | 3.13:1 FAIL |
| White on the solid danger colour (their `.lof-btn--danger`) | 4.5:1 | 3.76:1 FAIL | 4.83:1 PASS |
| White on the solid primary colour | 4.5:1 | 4.83:1 PASS | 5.70:1 PASS |
| Page text colour on the solid primary colour | 4.5:1 | 4.83:1 PASS | 2.81:1 FAIL |
| Page text colour on the solid danger colour | 4.5:1 | 3.76:1 FAIL | 3.31:1 FAIL |
| Page text colour on a 15% status tint (our chips) | 4.5:1 | 12.76:1 PASS | 14.04:1 PASS |
| Secondary text on a 15% status tint | 4.5:1 | 7.98:1 PASS | 6.22:1 PASS |
| Card border against the card (decorative — see 2.7) | 3:1 | 1.20:1 | 1.36:1 |
| **White on the primary gradient (Nebula end `#7B4DFF`)** — axe cannot see gradients | 4.5:1 | 4.83:1 PASS | — |
| **White on the primary gradient (Nebula end `#4C8DFF`)** — axe cannot see gradients | 4.5:1 | **3.20:1 FAIL** | — |
| **White on the primary gradient (Horizon end `#7C3AED`)** — axe cannot see gradients | 4.5:1 | — | 5.70:1 PASS |
| **White on the primary gradient (Horizon end `#A855F7`)** — axe cannot see gradients | 4.5:1 | — | **3.96:1 FAIL** |

---

## 4. One more request, not about contrast

`lof-lms-tokens.css` begins with `@import url('https://fonts.googleapis.com/…')`. A CSS
`@import` is render-blocking, and it sends every learner's IP to Google on each load. Your own
comment offers the alternative ("Add the same line to your `<head>` (preferred)"). We now
self-host the same three families with `next/font` and load a generated copy of your file with
that one line removed — nothing else is changed, and the original stays byte-identical in our
repo. A version of the file without the `@import` would let every tool do this without a build
step.
