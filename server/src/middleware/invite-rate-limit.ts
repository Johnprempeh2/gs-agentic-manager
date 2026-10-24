import type { RequestHandler } from "express";
import { tooManyRequests } from "../errors.js";
import type { InviteRateLimiter } from "../services/invite-rate-limit.js";

// Mount path for the invite-token limiter. A router-level `use` on this path
// covers every current and future `/invites/:token` sub-route.
export const INVITE_RATE_LIMIT_PATH = "/invites/:token";

// Per-IP rate limit for the public, unauthenticated invite-token endpoints.
// The token is looked up by hash, so without a limit the token space would be
// online-enumerable.
//
// The key is deliberately NOT `requestIp()`: that helper prefers the
// client-supplied `X-Forwarded-For` header (fine for log/audit fields, but
// trivially spoofable as a rate-limit key — rotating fake XFF values would mint
// a fresh budget per request). `req.ip` honors Express's `trust proxy` setting
// (configured from TRUST_PROXY in app.ts, default: trust nothing), so it is the
// socket's remote address unless the operator explicitly trusts a proxy — an
// unforgeable key either way.
export function inviteRateLimitMiddleware(limiter: InviteRateLimiter): RequestHandler {
  return (req, res, next) => {
    const result = limiter.consume(req.ip || req.socket?.remoteAddress || "unknown");
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      next(
        tooManyRequests("Too many invite requests", {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
      return;
    }
    next();
  };
}
