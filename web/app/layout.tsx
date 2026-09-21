import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// Order matters: their tokens define the --nebula-*/--lof-* variables, ours
// alias them, globals.css consumes both. Loading theirs second would leave our
// aliases pointing at undefined variables.
import '../styles/lof-lms-tokens.css';
import '../styles/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mission Hub',
  description: 'Your weekly missions',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Keyboard/SR users can jump straight to the page content, past the header. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
