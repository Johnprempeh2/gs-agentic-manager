import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../middleware/security-headers.js";

function createApp(publicBaseUrl?: string) {
  const app = express();
  app.use(securityHeaders({ publicBaseUrl }));
  app.get("/page", (_req, res) => {
    res.send("ok");
  });
  app.get("/attachment", (_req, res) => {
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.send("file");
  });
  return app;
}

describe("securityHeaders", () => {
  it("sets the baseline headers and stops other sites framing the board", async () => {
    const res = await request(createApp("https://c001.example.com")).get("/page");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["strict-transport-security"]).toBe("max-age=15552000");
  });

  it("sends no HSTS when the public address is plain HTTP or unset", async () => {
    expect((await request(createApp("http://127.0.0.1:3100")).get("/page")).headers["strict-transport-security"]).toBeUndefined();
    expect((await request(createApp()).get("/page")).headers["strict-transport-security"]).toBeUndefined();
  });

  it("lets a route replace the policy with a stricter one", async () => {
    const res = await request(createApp()).get("/attachment");
    expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  });
});
