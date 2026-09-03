import Link from 'next/link';
import type { Me } from '@/lib/api/types';
import { SignOutButton } from './SignOutButton';

/** Top bar: product name + student nav + who's signed in + sign out. */
export function Header({ me }: { me: Me }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-content items-center justify-between px-4 py-3">
        <div className="flex items-center gap-5">
          <span className="text-lg font-bold text-primary">Mission Hub</span>
          {me.role === 'student' && (
            <nav className="flex items-center gap-4 text-sm font-medium">
              <Link href="/week" className="text-text-muted hover:text-text">
                This week
              </Link>
              <Link href="/progress" className="text-text-muted hover:text-text">
                Progress
              </Link>
            </nav>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted">{me.display_name ?? `User ${me.id}`}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
