// An agent's browser QA log-in (GRE-2387) can look and, as an Operator, do
// ordinary work. It can never approve cards, publish, move money, or make
// itself a longer-lived credential. This guard refuses those writes in one
// place, before any route runs, so a new route under the same paths is
// covered too. Reads are never refused here.

import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths (under /api) a QA log-in may never write to. */
export const QA_LOGIN_DENIED_WRITE_PATHS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  // Cards: approvals and Decisions.
  { pattern: /^\/approvals\/[^/]+\/(approve|reject|resubmit)\/?$/, what: "approve cards" },
  { pattern: /^\/companies\/[^/]+\/approvals\/?$/, what: "approve cards" },
  { pattern: /^\/issues\/[^/]+\/approvals\//, what: "approve cards" },
  { pattern: /^\/issues\/[^/]+\/interactions\/[^/]+\/(accept|reject|respond|verdicts|skip|steps-progress)\/?$/, what: "answer Decisions cards" },
  { pattern: /^\/agents\/[^/]+\/approve\/?$/, what: "approve cards" },
  { pattern: /^\/companies\/[^/]+\/secret-proposals\/[^/]+\/(approve|reject)\/?$/, what: "approve cards" },
  { pattern: /^\/tool-gateway\/action-requests\/[^/]+\/approve\/?$/, what: "approve cards" },
  { pattern: /^\/memory-oauth\/approve\/?$/, what: "approve cards" },
  { pattern: /^\/strategy-board\/packs\/[^/]+\/accept\/?$/, what: "approve cards" },
  { pattern: /^\/client-acceptance\//, what: "approve cards" },
  { pattern: /^\/cases\/[^/]+\/engagement\/acceptance\/?$/, what: "approve cards" },
  // Publishing and releases.
  { pattern: /publish/i, what: "publish" },
  { pattern: /^\/companies\/[^/]+\/releases\//, what: "publish" },
  // Money.
  { pattern: /^\/companies\/[^/]+\/budget/, what: "move money" },
  { pattern: /^\/agents\/[^/]+\/budgets\/?$/, what: "move money" },
  { pattern: /^\/instance\/billing-account/, what: "move money" },
  { pattern: /(^|\/)(top-ups?|payments?|payouts?|invoices?|spend)(\/|$)/i, what: "move money" },
  // Credentials that would outlive the QA grant.
  { pattern: /^\/cli-auth\/challenges\/[^/]+\/approve\/?$/, what: "make API keys" },
  { pattern: /^\/board-api-keys/, what: "make API keys" },
  // Its own log-in: name (the "QA for" label), email, password, two-step, linked accounts.
  { pattern: /^\/auth\/(?!sign-out\/?$)/, what: "change its own log-in" },
  // Its own access.
  { pattern: /^\/companies\/[^/]+\/(members|invites)/, what: "change members" },
  { pattern: /^\/agents\/[^/]+\/qa-login/, what: "change QA access" },
];

export function qaLoginDeniedReason(method: string, path: string): string | null {
  if (SAFE_METHODS.has(method.toUpperCase())) return null;
  const hit = QA_LOGIN_DENIED_WRITE_PATHS.find((entry) => entry.pattern.test(path));
  return hit ? hit.what : null;
}

/** Mount on /api after the actor middleware. */
export function qaLoginGuard(): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor?.qaLogin) {
      next();
      return;
    }
    const what = qaLoginDeniedReason(req.method, req.path);
    if (what) {
      next(forbidden(`A browser QA log-in cannot ${what}.`, { code: "qa_login_forbidden" }));
      return;
    }
    next();
  };
}
