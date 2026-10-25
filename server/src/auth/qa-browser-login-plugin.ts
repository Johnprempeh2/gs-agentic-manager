/**
 * Better Auth endpoint that turns a one-time QA login link into a session
 * (GRE-2387). A plugin endpoint, like the workspace login handoff, so the
 * session and its cookie are made by Better Auth itself.
 */

import { setSessionCookie } from "better-auth/cookies";
import { createAuthEndpoint } from "better-auth/api";
import type { Session, User } from "better-auth/types";
import type { Db } from "@greatstone/db";
import { logger } from "../middleware/logger.js";
import { agentQaLoginService } from "../services/agent-qa-logins.js";
import {
  exchangeQaBrowserLoginTicket,
  QA_BROWSER_LOGIN_EXCHANGE_PATH,
  QA_BROWSER_LOGIN_TICKET_QUERY_PARAM,
  resolveQaBrowserLoginKey,
} from "./qa-browser-login.js";

/** The slice of Better Auth's endpoint context this exchange uses. */
type QaBrowserLoginEndpointContext = {
  query?: Record<string, unknown>;
  setHeader: (name: string, value: string) => void;
  redirect: (url: string) => unknown;
  error: (status: string, body?: Record<string, unknown>) => unknown;
  context: {
    internalAdapter: {
      findUserById: (userId: string) => Promise<User | null>;
      createSession: (userId: string) => Promise<Session | null>;
      findVerificationValue: (identifier: string) => Promise<{ identifier: string } | null>;
      reserveVerificationValue: (data: { identifier: string; value: string; expiresAt: Date }) => Promise<boolean>;
    };
  };
};

export function qaBrowserLoginPlugin(deps: { db: Db }) {
  const qaLogins = agentQaLoginService(deps.db);
  return {
    id: "gsam-qa-browser-login",
    endpoints: {
      exchangeQaBrowserLogin: createAuthEndpoint(
        QA_BROWSER_LOGIN_EXCHANGE_PATH,
        { method: "GET", requireHeaders: true },
        async (endpointContext) => {
          const ctx = endpointContext as unknown as QaBrowserLoginEndpointContext;
          const rawTicket = ctx.query?.[QA_BROWSER_LOGIN_TICKET_QUERY_PARAM];
          ctx.setHeader("Cache-Control", "no-store");
          ctx.setHeader("Referrer-Policy", "no-referrer");

          const result = await exchangeQaBrowserLoginTicket({
            ticket: typeof rawTicket === "string" ? rawTicket : null,
            key: resolveQaBrowserLoginKey(),
            deps: {
              isGrantLive: (payload) =>
                qaLogins.isGrantLive({
                  loginId: payload.lid,
                  userId: payload.sub,
                  companyId: payload.cid,
                  agentId: payload.aid,
                }),
              reserveNonce: async ({ nonce, expiresAt }) => {
                const identifier = `qa-browser-login:${nonce}`;
                // Lookup for a plain replay; primary-key insert for a race.
                if (await ctx.context.internalAdapter.findVerificationValue(identifier)) return false;
                return ctx.context.internalAdapter.reserveVerificationValue({ identifier, value: "consumed", expiresAt });
              },
              createSession: async (userId) => {
                const user = await ctx.context.internalAdapter.findUserById(userId);
                if (!user) throw new Error("QA user not found");
                const session = await ctx.context.internalAdapter.createSession(userId);
                if (!session) throw new Error("Better Auth did not return a session");
                await setSessionCookie(ctx as never, { session, user });
              },
            },
          });

          if (!result.ok) {
            // Log the nonce and reason, never the ticket.
            logger.warn(
              { reason: result.reason, nonce: result.payload?.jti ?? null, qaLoginId: result.payload?.lid ?? null },
              "QA browser login rejected",
            );
            if (result.reason === "not_configured" || result.reason === "session_failed") {
              throw ctx.error(result.reason === "not_configured" ? "SERVICE_UNAVAILABLE" : "INTERNAL_SERVER_ERROR", {
                message: "QA browser login is unavailable",
                code: result.reason,
              });
            }
            throw ctx.error("UNAUTHORIZED", {
              message: "This QA login link is not valid. Ask for a new one.",
              code: result.reason === "grant_not_live" ? "qa_login_not_live" : "qa_login_link_invalid",
            });
          }

          logger.info(
            { nonce: result.payload.jti, qaLoginId: result.payload.lid, agentId: result.payload.aid },
            "QA browser login accepted",
          );
          // An HTTP redirect keeps the ticket URL out of browser history.
          throw ctx.redirect("/");
        },
      ),
    },
  };
}
