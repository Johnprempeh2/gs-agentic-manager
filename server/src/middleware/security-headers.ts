import type { RequestHandler } from "express";

/**
 * Baseline browser protections on every response, for an instance that may sit
 * on the public internet (one client instance per server, GRE-664).
 *
 * - `X-Content-Type-Options: nosniff`: a file is never run as a type it was
 *   not served as.
 * - `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`: no other site
 *   can put the board in a frame (clickjacking). The app's own previews still
 *   frame its own pages.
 * - `Referrer-Policy: strict-origin-when-cross-origin`: links out never carry
 *   a page path, which can hold a token (invites, acceptance links).
 * - `Strict-Transport-Security`, only when the instance's public address is
 *   HTTPS: browsers then refuse plain HTTP to that host.
 *
 * Routes that need a stricter Content-Security-Policy (attachments, sandboxed
 * previews) set their own, which replaces this one.
 */
export function securityHeaders(opts: { publicBaseUrl?: string | undefined }): RequestHandler {
  const hsts = isHttps(opts.publicBaseUrl);
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (hsts) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    next();
  };
}

function isHttps(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
