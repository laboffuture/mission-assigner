/**
 * Same-origin deployment: the browser only ever talks to one origin, so the
 * session cookie stays first-party and there is no CORS anywhere.
 *
 * WHO PROXIES /api DEPENDS ON WHERE WE RUN, and that is deliberate:
 *
 *   local dev  — Next rewrites /api/* to the Express API (API_ORIGIN). One
 *                command, one port, nothing else to run.
 *   production — Caddy routes /api/* straight to the api container and
 *                everything else to this server (infra/Caddyfile). The same
 *                origin as far as the browser is concerned, so cookies and CSRF
 *                behave exactly as they do locally, with one hop fewer.
 *
 * The rewrite is therefore off in production: leaving it on would mean
 * Caddy → Next → Express for every API call, an extra hop that buys nothing
 * (and is where Next's bundled http-proxy raises the DEP0060 warning — see
 * "Known warnings" in the README).
 *
 * `output: 'standalone'` makes Next trace exactly the files the server needs and
 * emit a self-contained server.js, which is what infra/Dockerfile.web ships.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3000';
const PROXY_API = process.env.NODE_ENV !== 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    return PROXY_API ? [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }] : [];
  },
};

export default nextConfig;
