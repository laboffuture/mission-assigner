import 'server-only';
import { headers as requestHeaders } from 'next/headers';
import { unwrap } from './error';

/**
 * Server-side API client for React Server Components.
 *
 * Talks DIRECTLY to Express (API_ORIGIN), forwarding the incoming request's
 * Cookie header so the signed session travels with the call. We do NOT verify or
 * parse the session cookie here — Express stays the single identity authority;
 * this client just relays cookies and reads /api/me etc. `no-store` because every
 * response is per-user and must never be cached.
 *
 * The Cookie header is forwarded RAW, byte for byte, from headers(). It must
 * not be rebuilt through cookies().toString(): Next re-serialises each value
 * with encodeURIComponent, which turns the '=' padding of the base64 session
 * payload into '%3D'. The payload no longer matches its signature, Express
 * answers 401, and the page redirects to /login — for every student whose
 * session happens to need padding, which depends only on how many digits their
 * id has. The e2e journeys run across ids of every length to keep it that way
 * (see e2e/helpers.ts BOUNDARY_IDS).
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3000';

async function serverFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = requestHeaders().get('cookie');
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
