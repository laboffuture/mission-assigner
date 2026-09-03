/**
 * Same-origin deployment: the browser only ever talks to the Next origin, and
 * Next proxies /api/* to the Express API (server-to-server). This keeps the
 * session cookie first-party and avoids CORS entirely. API_ORIGIN points at the
 * Express server (default local dev port 3000).
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
