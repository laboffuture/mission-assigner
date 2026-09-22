import Link from 'next/link';
import type { Me } from '@/lib/api/types';
import { SignOutButton } from './SignOutButton';

type Section = 'week' | 'progress' | 'staff' | null;

const STUDENT_TABS: { href: string; label: string; section: Section }[] = [
  { href: '/week', label: 'This week', section: 'week' },
  { href: '/progress', label: 'Progress', section: 'progress' },
];

/**
 * In-content navigation.
 *
 * The app used to carry its own header bar, which put a second product name and
 * a second nav row directly under the LMS's own header (audit #55 — the LMS
 * provides the page header). The bar is gone; the links it held live here, at
 * the top of the page content, as tabs. This is NOT a banner: no <header>, no
 * role="banner" — just a labelled <nav> inside the page.
 *
 * The current section is marked with aria-current="page" as well as an
 * underline, so it is not signalled by colour alone.
 */
export function PageNav({ me, current = null }: { me: Me; current?: Section }) {
  const tabs = me.role === 'student' ? STUDENT_TABS : [];

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
      {tabs.length > 0 ? (
        <nav aria-label="Sections">
          <ul className="flex items-center gap-4 text-sm font-semibold">
            {tabs.map((t) => {
              const active = t.section === current;
              return (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    aria-current={active ? 'page' : undefined}
                    className={
                      active
                        ? 'inline-block border-b-2 border-primary pb-1 text-text'
                        : 'inline-block border-b-2 border-transparent pb-1 text-link hover:underline'
                    }
                  >
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-3">
        <span className="text-sm text-text-secondary">{me.display_name ?? `User ${me.id}`}</span>
        <SignOutButton />
      </div>
    </div>
  );
}
