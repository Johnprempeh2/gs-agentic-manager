import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { integrationKeyItems, integrationKeyRoutes } from "../routes/integration-keys.js";

describe("integration keys", () => {
  it("says what is waiting and never returns a value", async () => {
    const env = { HIGGSFIELD_API_KEY_ID: "id-123", HIGGSFIELD_API_KEY_SECRET: "secret-456" };
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "u", source: "local_implicit", companyIds: ["c1"], memberships: [], isInstanceAdmin: false } as never;
      next();
    });
    app.use("/api", integrationKeyRoutes({} as never, { env, envFile: "/home/gsam/.gsam/instances/default/.env" }));
    app.use(errorHandler);
    const res = await request(app).get("/api/companies/c1/integration-keys");
    expect(res.status).toBe(200);
    expect(res.body.envFile).toBe("/home/gsam/.gsam/instances/default/.env");
    expect(res.body.items.find((item: { id: string }) => item.id === "higgsfield")).toMatchObject({
      state: "ready",
      variables: [{ name: "HIGGSFIELD_API_KEY_ID", set: true }, { name: "HIGGSFIELD_API_KEY_SECRET", set: true }],
    });
    expect(JSON.stringify(res.body)).not.toContain("secret-456");
  });

  it("marks missing keys, unbuilt features and sign-in only ones", () => {
    const items = integrationKeyItems({ GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID: "x" });
    const state = Object.fromEntries(items.map((item) => [item.id, item.state]));
    expect(state).toEqual({ higgsfield: "needs_key", google: "needs_key", microsoft: "not_built", hubspot: "sign_in" });
    expect(items.find((item) => item.id === "higgsfield")!.getKey).toEqual({
      url: "https://console.higgsfield.ai",
      label: "Open the Higgsfield console",
    });
    expect(items.find((item) => item.id === "google")!.variables).toEqual([
      { name: "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID", set: true },
      { name: "GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET", set: false },
    ]);
  });
});
