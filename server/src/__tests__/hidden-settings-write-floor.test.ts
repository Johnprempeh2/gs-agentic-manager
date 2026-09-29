import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Operator-hidden settings write floor (GRE-107): with `instance.environments`,
 * `company.secrets`, `company.export`, or `company.invites` in
 * GSAM_HIDDEN_SETTINGS, every write route for that surface returns 403
 * `settings_operator_managed` before any data access. With the key not
 * hidden, the request passes the floor and reaches the route's own handler
 * (the stub db makes it fail there, never with the floor code). The real
 * not-hidden happy paths are covered by each router's own route tests.
 */

const stubDb = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === "then") return undefined;
    throw new Error(`stub db: ${String(prop)}`);
  },
}) as never;

async function createApp() {
  const [
    { accessRoutes },
    { companyRoutes },
    { environmentRoutes },
    { secretRoutes },
    { errorHandler },
  ] = await Promise.all([
    import("../routes/access.js"),
    import("../routes/companies.js"),
    import("../routes/environments.js"),
    import("../routes/secrets.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "owner-1",
      source: "local_implicit",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    } as Express.Request["actor"];
    next();
  });
  app.use("/api/companies", companyRoutes(stubDb));
  app.use("/api", environmentRoutes(stubDb));
  app.use("/api", secretRoutes(stubDb));
  app.use("/api", accessRoutes(stubDb, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
  return app;
}

type Attempt = [name: string, build: (app: express.Express) => request.Test];

const surfaces: Array<{ key: string; attempts: Attempt[] }> = [
  {
    key: "instance.environments",
    attempts: [
      ["create", (app) => request(app).post("/api/companies/company-1/environments").send({})],
      ["update", (app) => request(app).patch("/api/environments/env-1").send({})],
      ["delete", (app) => request(app).delete("/api/environments/env-1")],
      ["probe", (app) => request(app).post("/api/environments/env-1/probe")],
      ["probe config", (app) => request(app).post("/api/companies/company-1/environments/probe-config").send({})],
      [
        "custom image setup",
        (app) => request(app).post("/api/environments/env-1/custom-image-setup-sessions").send({}),
      ],
      ["custom image delete", (app) => request(app).delete("/api/environments/env-1/custom-image-template")],
      [
        "custom image session finish",
        (app) => request(app).post("/api/environment-custom-image-setup-sessions/s-1/finish").send({}),
      ],
    ],
  },
  {
    key: "company.secrets",
    attempts: [
      ["create", (app) => request(app).post("/api/companies/company-1/secrets").send({})],
      ["update", (app) => request(app).patch("/api/secrets/secret-1").send({})],
      ["delete", (app) => request(app).delete("/api/secrets/secret-1")],
      ["rotate", (app) => request(app).post("/api/secrets/secret-1/rotate").send({})],
      ["remote import", (app) => request(app).post("/api/companies/company-1/secrets/remote-import").send({})],
      [
        "provider config create",
        (app) => request(app).post("/api/companies/company-1/secret-provider-configs").send({}),
      ],
      ["provider config update", (app) => request(app).patch("/api/secret-provider-configs/p-1").send({})],
      ["provider config delete", (app) => request(app).delete("/api/secret-provider-configs/p-1")],
      [
        "user secret definition create",
        (app) => request(app).post("/api/companies/company-1/user-secret-definitions").send({}),
      ],
      [
        "proposal approve",
        (app) => request(app).post("/api/companies/company-1/secret-proposals/p-1/approve").send({}),
      ],
    ],
  },
  {
    key: "company.export",
    attempts: [
      ["export", (app) => request(app).post("/api/companies/company-1/export").send({})],
      ["exports", (app) => request(app).post("/api/companies/company-1/exports").send({})],
      ["export preview", (app) => request(app).post("/api/companies/company-1/exports/preview").send({})],
    ],
  },
  {
    key: "company.invites",
    attempts: [
      ["create", (app) => request(app).post("/api/companies/company-1/invites").send({})],
      [
        "openclaw invite prompt",
        (app) => request(app).post("/api/companies/company-1/openclaw/invite-prompt").send({}),
      ],
      ["revoke", (app) => request(app).post("/api/invites/invite-1/revoke")],
    ],
  },
];

describe("operator-hidden settings write floor", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await createApp();
  }, 60_000);

  afterEach(() => {
    delete process.env.GSAM_HIDDEN_SETTINGS;
  });

  for (const { key, attempts } of surfaces) {
    describe(key, () => {
      it.each(attempts)("rejects %s with 403 when hidden", async (_name, build) => {
        process.env.GSAM_HIDDEN_SETTINGS = key;

        const res = await build(app);

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      });

      it.each(attempts)("lets %s through the floor when not hidden", async (_name, build) => {
        // Hide every other surface so a floor keyed to the wrong setting fails here.
        process.env.GSAM_HIDDEN_SETTINGS = surfaces
          .map((surface) => surface.key)
          .filter((other) => other !== key)
          .join(",");

        const res = await build(app);

        expect(res.body?.details?.code, JSON.stringify(res.body)).not.toBe("settings_operator_managed");
      });
    });
  }

  it("keeps reads open when every surface is hidden", async () => {
    process.env.GSAM_HIDDEN_SETTINGS = surfaces.map((surface) => surface.key).join(",");

    const reads = [
      request(app).get("/api/companies/company-1/environments"),
      request(app).get("/api/companies/company-1/secrets"),
      request(app).get("/api/companies/company-1/invites"),
    ];
    for (const res of await Promise.all(reads)) {
      expect(res.body?.details?.code, JSON.stringify(res.body)).not.toBe("settings_operator_managed");
    }
  });
});
