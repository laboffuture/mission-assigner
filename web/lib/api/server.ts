import 'server-only';
import { cookies } from 'next/headers';
import { unwrap } from './error';

/**
 * Server-side API client for React Server Components.
 *
 * Talks DIRECTLY to Express (API_ORIGIN), forwarding the incoming request's
 * Cookie header so the signed session travels with the call. We do NOT verify or
 * parse the session cookie here — Express stays the single identity authority;
 * this client just relays cookies and reads /api/me etc. `no-store` because every
 * response is per-user and must never be cached.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3000';

async function serverFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = cookies().toString();
  const headers = new Headers(init?.headers);
  if (cookieHeader) headers.set('cookie', cookieHeader);
  const res = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
  return unwrap<T>(res);
}

export const serverApi = {
  get: <T>(path: string) => serverFetch<T>(path),
};
