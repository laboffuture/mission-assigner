'use client';
import { unwrap } from './error';

/**
 * Browser-side API client for Client Components.
 *
 * Uses relative URLs, so requests hit the Next origin and are proxied to Express
 * (same-origin — cookies ride along automatically). On every mutation it echoes
 * the readable `mh_csrf` cookie in the `X-CSRF-Token` header (double-submit). The
 * server only enforces this when CSRF_ENFORCED=true, but the client always sends
 * it, so enabling enforcement for LTI is a server config flip with no code change
 * here.
 */

function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)mh_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) headers.set('X-CSRF-Token', token);
    if (init.body != null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }
  const res = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });
  return unwrap<T>(res);
}

export const clientApi = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data == null ? undefined : JSON.stringify(data) }),
};
