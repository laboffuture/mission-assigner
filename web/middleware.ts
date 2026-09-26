import { NextResponse, type NextRequest } from 'next/server';

/**
 * Theme selection, server-side.
 *
 * WHERE THE THEME COMES FROM, in order:
 *
 *   1. `?theme=nebula|horizon` on this request — the testing override. Passed to
 *      the render as a header so this very page is already correct, and kept in a
 *      FIRST-PARTY cookie so it survives navigation while testing.
 *   2. the session (`/api/me` → `theme`), which is where the LTI launch puts the
 *      LMS's own value. This is the real mechanism; see app/layout.tsx.
 *   3. nebula, the LMS default.
 *
 * The cookie used to be `SameSite=None; Secure` so it would survive inside the
 * LMS's cross-site iframe. That was wrong twice over: WebKit will not send a
 * Secure cookie to an http origin, so every theme test failed on Safari and iPad,
 * and Safari blocks third-party cookies in an iframe anyway, so it would not have
 * survived the thing it was written for. It is now an ordinary first-party cookie
 * for top-level testing, and the theme that matters travels in the session.
 */
export const THEME_COOKIE = 'lof_theme';
/** The render reads the override from here; middleware is the only writer. */
export const THEME_HEADER = 'x-lof-theme';
export const THEMES = ['nebula', 'horizon'] as const;
export type Theme = (typeof THEMES)[number];

export function middleware(request: NextRequest) {
  const asked = request.nextUrl.searchParams.get('theme');
  if (!asked || !THEMES.includes(asked as Theme)) return NextResponse.next();

  // Tell THIS render about it: a header rather than a mutated cookie, because the
  // override is a property of the request, not something the browser sent.
  const headers = new Headers(request.headers);
  headers.set(THEME_HEADER, asked);
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set(THEME_COOKIE, asked, {
    path: '/',
    sameSite: 'lax', // first-party only: the session carries the theme in the iframe
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true, // nothing in the page reads it; the server renders the theme
  });
  return response;
}

export const config = {
  // Everything except Next's own assets — the theme must apply to every page.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
