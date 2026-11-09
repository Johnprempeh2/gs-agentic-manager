import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { assertBoard, assertBoardOrgAccess, BOARD_ACCESS_REQUIRED_CODE } from "../routes/authz.js";
import { buildOpenApiDocument } from "../routes/openapi.js";

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";

const agentActor: Express.Request["actor"] = { type: "agent", source: "agent_key", agentId: "agent-1", companyId: COMPANY_ID };
const boardActor: Express.Request["actor"] = { type: "board", source: "local_implicit", userId: "local-board" };

function createApp(actor: Express.Request["actor"], guard = assertBoard) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  const router = express.Router();
  router.all(/.*/, (req, res) => {
    guard(req);
    res.json({ ok: true });
  });
  app.use("/api", router);
  app.use(errorHandler);
  return app;
}

describe("board-only denial", () => {
  it.each([
    ["post", `/api/companies/${COMPANY_ID}/archive`, "[Open company settings](/<prefix>/company/settings)"],
    ["post", `/api/companies/${COMPANY_ID}/secrets`, "[Open company secrets](/<prefix>/company/settings/secrets)"],
    ["post", `/api/secrets/${AGENT_ID}/rotate`, "[Open company secrets](/<prefix>/company/settings/secrets)"],
    ["post", `/api/companies/${COMPANY_ID}/budget-incidents/i-1/resolve?x=1`, "[Open budgets](/<prefix>/activity/budgets)"],
    ["put", `/api/agents/${AGENT_ID}/instructions-bundle`, `[Open the agent's instructions](/<prefix>/agents/${AGENT_ID}/instructions)`],
    ["patch", `/api/agents/${AGENT_ID}/configuration`, `[Open the agent's harness settings](/<prefix>/agents/${AGENT_ID}/runtime)`],
    ["patch", `/api/agents/${AGENT_ID}/permissions`, `[Open the agent's permissions](/<prefix>/agents/${AGENT_ID}/permissions)`],
    ["post", `/api/agents/${AGENT_ID}/keys`, `[Open the agent's API keys](/<prefix>/agents/${AGENT_ID}/api-keys)`],
    ["post", `/api/agents/${AGENT_ID}/pause`, `[Open the agent's profile](/<prefix>/agents/${AGENT_ID})`],
  ] as const)("tells an agent %s %s is final and names the board page", async (method, path, link) => {
    const res = await request(createApp(agentActor))[method](path).expect(403);
    expect(res.body.error).toBe("Board access required");
    expect(res.body.code).toBe(BOARD_ACCESS_REQUIRED_CODE);
    expect(res.body.remediation).toContain("This denial is final");
    expect(res.body.remediation).toContain("Do not search for one");
    expect(res.body.remediation).toContain(link);
  });

  it("falls back to a general board instruction when no page is known", async () => {
    const res = await request(createApp(agentActor)).get(`/api/companies/${COMPANY_ID}/managed-agent-profiles`).expect(403);
    expect(res.body.code).toBe(BOARD_ACCESS_REQUIRED_CODE);
    expect(res.body.remediation).toContain("This denial is final");
    expect(res.body.remediation).toContain("GS Agentic Manager web app or with their own board credentials");
    expect(res.body.remediation).toContain("Link a page only if you already know its route. Do not search for one");
    expect(res.body.remediation).not.toContain("](/");
  });

  it("does not link an agent budget tab, which our agent page does not have", async () => {
    const res = await request(createApp(agentActor)).patch(`/api/agents/${AGENT_ID}/budgets`).expect(403);
    expect(res.body.remediation).toContain(`[Open the agent's profile](/<prefix>/agents/${AGENT_ID})`);
  });

  it("applies through the org-access guard", async () => {
    const res = await request(createApp(agentActor, assertBoardOrgAccess)).delete(`/api/companies/${COMPANY_ID}`).expect(403);
    expect(res.body.code).toBe(BOARD_ACCESS_REQUIRED_CODE);
    expect(res.body.remediation).toContain("[Open company settings](/<prefix>/company/settings)");
  });

  it("keeps the plain denial for actors that are not agents", async () => {
    const res = await request(createApp({ type: "none", source: "none" })).post(`/api/companies/${COMPANY_ID}/archive`).expect(403);
    expect(res.body).toEqual({ error: "Board access required" });
    await request(createApp(boardActor)).post(`/api/companies/${COMPANY_ID}/archive`).expect(200);
  });

  it("says in the API catalog who sets up a Claude Managed Agent profile", () => {
    const post = buildOpenApiDocument().paths["/api/companies/{companyId}/managed-agent-profiles"].post;
    expect(post["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(post.description).toContain("Board only: agent credentials get 403");
    expect(post.description).toContain("explicitly acknowledges stateful retention");
  });
});
