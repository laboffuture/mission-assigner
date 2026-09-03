import type { Me } from '@/lib/api/types';
import { SignOutButton } from './SignOutButton';

/** Top bar: product name + who's signed in + sign out. Server component. */
export function Header({ me }: { me: Me }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-content items-center justify-between px-4 py-3">
        <span className="text-lg font-bold text-primary">Mission Hub</span>
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-muted">
            {me.display_name ?? `User ${me.id}`}
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
