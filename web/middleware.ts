import { NextResponse, type NextRequest } from 'next/server';

/**
 * Theme selection, server-side.
 *
 * The LMS tells an LTI tool which theme the learner is using. Until the launch
 * contract is agreed we accept it as `?theme=nebula|horizon` on any URL (the
 * LTI launch will carry the same value), remember it in a cookie so it survives
 * navigation inside the tool, and let app/layout.tsx render
 * <html data-lof-theme> with it on the SERVER — so the first paint is already
 * in the right theme and there is no flash of the wrong one.
 *
 * Anything else (missing, misspelt) falls back to nebula, the LMS default.
 */
export const THEME_COOKIE = 'lof_theme';
export const THEMES = ['nebula', 'horizon'] as const;
export type Theme = (typeof THEMES)[number];

export function middleware(request: NextRequest) {
  const asked = request.nextUrl.searchParams.get('theme');
  if (!asked || !THEMES.includes(asked as Theme)) return NextResponse.next();

  // Set it on the REQUEST too, so this very render already sees it.
  request.cookies.set(THEME_COOKIE, asked);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(THEME_COOKIE, asked, {
    path: '/',
    sameSite: 'none', // the tool runs in the LMS's iframe, cross-site
    secure: true,
    httpOnly: false, // not a secret; readable by the page is fine
  });
  return response;
}

export const config = {
  // Everything except Next's own assets — the theme must apply to every page.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
