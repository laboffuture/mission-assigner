import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../styles/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mission Hub',
  description: 'Your weekly missions',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
