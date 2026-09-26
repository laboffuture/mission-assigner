import 'server-only';
import { cache } from 'react';
import { serverApi } from './api/server';
import { ApiError } from './api/error';
import type { Me } from './api/types';

/**
 * Resolve the current identity by asking Express (GET /api/me), forwarding the
 * session cookie. Returns null when unauthenticated (401) so callers can
 * redirect to the login/launch entry point. Express remains the sole authority
 * on who the user is — we never decode the cookie ourselves.
 */
/**
 * Memoised for the render pass: the root layout needs it for the theme and the
 * page needs it for the identity, and that is one request, not two.
 */
export const getMe = cache(async function getMe(): Promise<Me | null> {
  try {
    return await serverApi.get<Me>('/api/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
});

/**
 * The session's theme, for the root layout. NEVER throws: the theme is cosmetic
 * and must not be able to take a page down. An unreachable API, a 500, anything —
 * the layout falls back to the LMS default and the page renders.
 */
export async function sessionTheme(): Promise<'nebula' | 'horizon' | null> {
  try {
    return (await getMe())?.theme ?? null;
  } catch {
    return null;
  }
}
