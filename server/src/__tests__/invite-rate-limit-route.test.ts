import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import {
  INVITE_RATE_LIMIT_PATH,
  inviteRateLimitMiddleware,
} from "../middleware/invite-rate-limit.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";

// The limiter middleware is mounted exactly as routes/access.ts mounts it
// (same path, same handler), behind a stand-in invite route that 404s. This
// avoids a cold import of the whole access-route graph, which alone took over
// 10s under CI load and timed out the first test (GRE-2308).
function createApp() {
  const app = express();
  const router = express.Router();
  router.use(
    INVITE_RATE_LIMIT_PATH,
    inviteRateLimitMiddleware(
      createInviteRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    ),
  );
  router.get("/invites/:token", (_req, res) => {
    res.status(404).json({ error: "Invite not found" });
  });
  router.post("/invites/:token/accept", (_req, res) => {
    res.status(404).json({ error: "Invite not found" });
  });
  app.use("/api", router);
  app.use(errorHandler);
  return app;
}

describe("invite-token endpoint rate limiting", () => {
  it("returns 429 once the per-IP threshold is exceeded", async () => {
    const app = createApp();

    const first = await request(app).get(
      "/api/invites/pcp_invite_aaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(first.status).toBe(404);
    expect(first.headers["x-ratelimit-limit"]).toBe("1");
    expect(first.headers["x-ratelimit-remaining"]).toBe("0");

    const limited = await request(app).get(
      "/api/invites/pcp_invite_aaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.body).toMatchObject({
      error: "Too many invite requests",
      details: { retryAfterSeconds: 60 },
    });
  });

  it("also rate-limits the accept sub-route", async () => {
    const app = createApp();

    await request(app).get("/api/invites/pcp_invite_bbbbbbbbbbbbbbbbbbbbbb");

    const limited = await request(app)
      .post("/api/invites/pcp_invite_bbbbbbbbbbbbbbbbbbbbbb/accept")
      .send({});
    expect(limited.status).toBe(429);
  });

  it("ignores client-supplied X-Forwarded-For — spoofed IPs do not reset the budget", async () => {
    // `trust proxy` is unset here (Express default: trust nothing), so the
    // rate-limit key is the socket's remote address. Rotating fake
    // X-Forwarded-For values must NOT mint a fresh per-IP budget.
    const app = createApp();

    const first = await request(app)
      .get("/api/invites/pcp_invite_cccccccccccccccccccccc")
      .set("x-forwarded-for", "1.1.1.1");
    expect(first.status).toBe(404);

    const spoofed = await request(app)
      .get("/api/invites/pcp_invite_cccccccccccccccccccccc")
      .set("x-forwarded-for", "1.1.1.2");
    expect(spoofed.status).toBe(429);
  });

  it("gives a spoofed X-Forwarded-For its own budget only when the proxy is trusted", async () => {
    // Control for the spoof test: with `trust proxy` on, req.ip follows XFF,
    // so the two requests above would get separate budgets. This proves the
    // spoof test's 429 comes from the socket key, not from a key that ignores
    // the address altogether.
    const app = createApp();
    app.set("trust proxy", true);

    await request(app)
      .get("/api/invites/pcp_invite_dddddddddddddddddddddd")
      .set("x-forwarded-for", "1.1.1.1");
    const otherIp = await request(app)
      .get("/api/invites/pcp_invite_dddddddddddddddddddddd")
      .set("x-forwarded-for", "1.1.1.2");
    expect(otherIp.status).toBe(404);
  });
});
