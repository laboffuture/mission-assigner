import type { Config } from 'tailwindcss';

/**
 * Tailwind theme is mapped ENTIRELY onto CSS custom properties defined in
 * styles/tokens.css. Components use only these semantic names (bg-surface,
 * text-muted, rounded-lg, …) — never a raw hex/rgb/font value. Swapping in the
 * LMS palette later is a one-file edit to styles/tokens.css.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        'surface-muted': 'var(--color-surface-muted)',
        border: 'var(--color-border)',
        text: 'var(--color-text)',
        'text-muted': 'var(--color-text-muted)',
        primary: 'var(--color-primary)',
        'primary-fg': 'var(--color-primary-fg)',
        'primary-muted': 'var(--color-primary-muted)',
        success: 'var(--color-success)',
        'success-fg': 'var(--color-success-fg)',
        'success-muted': 'var(--color-success-muted)',
        danger: 'var(--color-danger)',
        'danger-fg': 'var(--color-danger-fg)',
        'danger-muted': 'var(--color-danger-muted)',
        warning: 'var(--color-warning)',
        'warning-muted': 'var(--color-warning-muted)',
        locked: 'var(--color-locked)',
        focus: 'var(--color-focus)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        full: 'var(--radius-full)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      maxWidth: {
        content: 'var(--width-content)',
      },
    },
  },
  plugins: [],
};

export default config;
