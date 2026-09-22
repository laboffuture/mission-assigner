import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { Sora, Inter, Space_Mono } from 'next/font/google';
// Order matters: their tokens define the --nebula-*/--lof-* variables, ours
// alias them, globals.css consumes both. Loading theirs second would leave our
// aliases pointing at undefined variables.
//
// The generated copy is their file with only the render-blocking Google Fonts
// @import removed — the same three families are loaded below by next/font,
// self-hosted and preloaded. See scripts/generate-lms-tokens.mjs.
import '../styles/generated/lof-lms-tokens.css';
import '../styles/tokens.css';
import './globals.css';
import { FrameHeightReporter } from '@/components/FrameHeightReporter';
import { THEME_COOKIE, THEMES, type Theme } from '@/middleware';

// The three LMS families, self-hosted by Next: no request to Google on load, no
// render-blocking stylesheet, and `display: swap` so text paints immediately.
// Each exposes a CSS variable that styles/tokens.css puts in front of their
// font token, keeping their value as the fallback.
const sora = Sora({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-display' });
const inter = Inter({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], variable: '--font-body' });
const spaceMono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Mission Hub',
  description: 'Your weekly missions',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Server-rendered theme: the first paint is already correct, so there is no
  // flash of the default theme before a client script swaps it. Set from
  // ?theme= by middleware.ts; nebula (the LMS default) otherwise.
  const asked = cookies().get(THEME_COOKIE)?.value;
  const theme: Theme = THEMES.includes(asked as Theme) ? (asked as Theme) : 'nebula';

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
