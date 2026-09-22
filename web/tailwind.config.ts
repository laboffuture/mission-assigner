import type { Config } from 'tailwindcss';

/**
 * Tailwind is configured to emit NOTHING of its own.
 *
 * Section 9 of the LOF LMS style guide asks tools not to load a second UI
 * framework "only for styling. It will fight these tokens and make the tool
 * look different." Rather than rip Tailwind out (a rewrite of every component),
 * we remove everything Tailwind would contribute on its own, so it becomes pure
 * shorthand for the LMS tokens:
 *
 *   - preflight is off, so their base styles on body/headings/links/inputs win;
 *   - `colors` REPLACES the palette (not `extend`), so bg-blue-500 and friends
 *     no longer compile — every colour resolves to a var(--nebula-*)/var(--lof-*);
 *   - `spacing`, `borderRadius` and `fontFamily` likewise replace the defaults
 *     and resolve to --lof-space-*, --lof-radius-* and --lof-font-*.
 *
 * Verified by `npm run check:tokens`, which now fails on a Tailwind
 * default-palette class name as well as on a raw hex.
 *
 * Our own semantic names (surface, text-muted, …) are kept as aliases of their
 * tokens in styles/tokens.css, so no component markup had to change.
 *
 * NOTE: turning preflight off removes the global `border-style: solid` that
 * Tailwind's border-width utilities depend on. globals.css restores exactly
 * that, and the other preflight behaviours our markup relies on, in a
 * compatibility layer — see the comments there.
 */

/**
 * Their six-step scale, plus the numeric keys our components already use, each
 * snapped to the nearest LOF step.
 *
 * Replacing the ramp outright would break 222 existing spacing utilities and
 * force exactly the rewrite we are avoiding. Aliasing instead means every
 * emitted value is one of their tokens while `p-4`/`gap-3` keep compiling — the
 * spacing rhythm becomes theirs, which is the point of adopting the scale.
 * Differences are 1-3px per step.
 */
const spacing = {
  0: '0px',
  px: '1px',

  // The LOF scale, usable directly: p-md, gap-lg, mb-2xl …
  xs: 'var(--lof-space-xs)', //  4px
  sm: 'var(--lof-space-sm)', //  6.4px
  md: 'var(--lof-space-md)', // 12.8px
  lg: 'var(--lof-space-lg)', // 19.2px
  xl: 'var(--lof-space-xl)', // 25.6px
  '2xl': 'var(--lof-space-2xl)', // 38.4px

  // Existing numeric utilities, aliased onto the same steps.
  0.5: 'var(--lof-space-xs)',
  1: 'var(--lof-space-xs)',
  1.5: 'var(--lof-space-sm)',
  2: 'var(--lof-space-sm)',
  2.5: 'var(--lof-space-md)',
  3: 'var(--lof-space-md)',
  4: 'var(--lof-space-lg)',
  5: 'var(--lof-space-lg)',
  6: 'var(--lof-space-xl)',
  8: 'var(--lof-space-2xl)',
  9: 'var(--lof-space-2xl)',

  // Layout dimensions, not rhythm: the LOF scale has no step this large, and
  // these size an avatar and a tile rather than the gaps between things.
  10: '2.5rem',
  40: '10rem',
};

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],

  // Their stylesheet owns the base layer. Tailwind's reset would override the
  // body/heading/link/input rules in section 4 of lof-lms-tokens.css.
  corePlugins: { preflight: false },

  theme: {
    // REPLACES Tailwind's palette — their tokens are the only colours available.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',

      // Our semantic aliases (defined in styles/tokens.css over their tokens).
      bg: 'var(--color-bg)',
      surface: 'var(--color-surface)',
      'surface-muted': 'var(--color-surface-muted)',
      border: 'var(--color-border)',
      'border-light': 'var(--color-border-light)',
      text: 'var(--color-text)',
      'text-muted': 'var(--color-text-muted)',
      'text-secondary': 'var(--color-text-secondary)',
      primary: 'var(--color-primary)',
      'primary-fg': 'var(--color-primary-fg)',
      'primary-muted': 'var(--color-primary-muted)',
      'primary-light': 'var(--color-primary-light)',
      link: 'var(--color-link)',
      'on-tint': 'var(--color-on-tint)',
      success: 'var(--color-success)',
      'success-muted': 'var(--color-success-muted)',
      danger: 'var(--color-danger)',
      'danger-muted': 'var(--color-danger-muted)',
      warning: 'var(--color-warning)',
      'warning-muted': 'var(--color-warning-muted)',
      locked: 'var(--color-locked)',
      focus: 'var(--color-focus)',

      // Their raw token names, for when a semantic alias would obscure intent.
      'lof-primary': 'var(--lof-primary)',
      'lof-accent': 'var(--lof-accent)',
      'nebula-blue': 'var(--nebula-blue)',
      'nebula-purple': 'var(--nebula-purple)',
    },

    spacing,

    borderRadius: {
      none: '0px',
      sm: 'var(--lof-radius-sm)',
      DEFAULT: 'var(--lof-radius-md)',
      md: 'var(--lof-radius-md)',
      lg: 'var(--lof-radius-lg)',
      xl: 'var(--lof-radius-xl)',
      full: 'var(--lof-radius-full)',
    },

    fontFamily: {
      display: 'var(--lof-font-display)',
      sans: 'var(--lof-font-body)',
      body: 'var(--lof-font-body)',
      mono: 'var(--lof-font-mono)',
    },

    // REPLACES Tailwind's type scale with the sizes their stylesheet uses
    // (named in styles/tokens.css), so text-sm/text-xl emit an LOF value and
    // Tailwind's own ramp cannot be reached. Line height comes with each size,
    // from their body (1.55) and heading (1.25) rules.
    fontSize: {
      xs: ['var(--text-badge)', { lineHeight: 'var(--leading-body)' }],
      sm: ['var(--text-small)', { lineHeight: 'var(--leading-body)' }],
      base: ['var(--text-body)', { lineHeight: 'var(--leading-body)' }],
      md: ['var(--text-h4)', { lineHeight: 'var(--leading-heading)' }],
      lg: ['var(--text-h3)', { lineHeight: 'var(--leading-heading)' }],
      xl: ['var(--text-h2)', { lineHeight: 'var(--leading-heading)' }],
      '2xl': ['var(--text-h1)', { lineHeight: 'var(--leading-heading)' }],
      '3xl': ['var(--text-display)', { lineHeight: 'var(--leading-heading)' }],
      '5xl': ['var(--text-display-lg)', { lineHeight: 'var(--leading-heading)' }],
    },

    // Their two letter-spacings (.lof-badge 0.02em, .lof-table th 0.04em).
    letterSpacing: {
      normal: '0',
      badge: 'var(--tracking-badge)',
      wide: 'var(--tracking-caps)',
    },

    lineHeight: {
      none: '1',
      heading: 'var(--leading-heading)',
      body: 'var(--leading-body)',
      relaxed: 'var(--leading-body)',
    },

    // REPLACES Tailwind's elevation ramp: their card shadow, and one derived
    // from their glow token. shadow-sm/md/lg no longer compile.
    boxShadow: {
      none: 'none',
      card: 'var(--nebula-card-shadow)',
      pop: 'var(--shadow-pop)',
    },

    extend: {
      maxWidth: {
        content: 'var(--width-content)',
      },
    },
  },

  plugins: [],
};

export default config;
