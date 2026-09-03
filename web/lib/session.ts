import 'server-only';
import { serverApi } from './api/server';
import { ApiError } from './api/error';
import type { Me } from './api/types';

/**
 * Resolve the current identity by asking Express (GET /api/me), forwarding the
 * session cookie. Returns null when unauthenticated (401) so callers can
 * redirect to the login/launch entry point. Express remains the sole authority
 * on who the user is — we never decode the cookie ourselves.
 */
export async function getMe(): Promise<Me | null> {
  try {
    return await serverApi.get<Me>('/api/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}
