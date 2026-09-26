import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import localFont from 'next/font/local';
// Order matters: their tokens define the --nebula-*/--lof-* variables, ours
// alias them, globals.css consumes both. Loading theirs second would leave our
// aliases pointing at undefined variables.
//
// The generated copy is their file with only the render-blocking Google Fonts
// @import removed — the same three families are loaded below from vendored files,
// self-hosted and preloaded. See scripts/generate-lms-tokens.mjs.
import '../styles/generated/lof-lms-tokens.css';
import '../styles/tokens.css';
import './globals.css';
import { FrameHeightReporter } from '@/components/FrameHeightReporter';
import { THEME_COOKIE, THEME_HEADER, THEMES, type Theme } from '@/middleware';
import { sessionTheme } from '@/lib/session';

// The three LMS families, from files IN THIS REPO.
//
// next/font/google self-hosts at runtime but downloads from fonts.googleapis.com
// at BUILD time, so `docker compose build` could fail because Google was
// unreachable — and once it did. A deploy to our own server must not depend on
// Google being up, so the woff2 files are vendored (web/scripts/vendor-fonts.mjs
// fetched them; nothing in the build fetches anything) and served from here.
//
// Sora and Inter are variable fonts: one file covers the whole weight range.
// Space Mono has no variable cut, so its two weights are separate files.
// `display: swap` still means text paints immediately, and each family exposes
// the same CSS variable styles/tokens.css already expects.
const sora = localFont({
  src: [{ path: './fonts/sora-latin-variable.woff2', weight: '400 800', style: 'normal' }],
  variable: '--font-display',
  display: 'swap',
});
const inter = localFont({
  src: [{ path: './fonts/inter-latin-variable.woff2', weight: '300 700', style: 'normal' }],
  variable: '--font-body',
  display: 'swap',
});
const spaceMono = localFont({
  src: [
    { path: './fonts/space-mono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/space-mono-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Mission Hub',
  description: 'Your weekly missions',
};

const asTheme = (v: string | null | undefined): Theme | null => (THEMES.includes(v as Theme) ? (v as Theme) : null);

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server-rendered theme: the first paint is already correct, so there is no
  // flash of the default theme before a client script swaps it.
  //
  // In order:
  //   1. ?theme= on this request (middleware sets THEME_HEADER) — the override
  //      used for testing, and the reason the next line exists at all.
  //   2. the first-party cookie middleware wrote from that same override, so it
  //      survives navigation while testing.
  //   3. THE SESSION, which is where the LTI launch puts the LMS's own theme.
  //      This is the mechanism that works inside the LMS iframe: no second
  //      cookie for Safari to block as third-party.
  //   4. nebula, the LMS default.
  const theme: Theme =
    asTheme(headers().get(THEME_HEADER)) ??
    asTheme(cookies().get(THEME_COOKIE)?.value) ??
    asTheme(await sessionTheme()) ??
    'nebula';

  return (
    <html lang="en" data-lof-theme={theme} className={`${sora.variable} ${inter.variable} ${spaceMono.variable}`}>
      <body>
        {/* Keyboard/SR users can jump straight to the page content. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg"
        >
          Skip to content
        </a>
        {children}
        <FrameHeightReporter />
      </body>
    </html>
  );
}
