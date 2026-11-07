import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { websitePingRoutes } from "../routes/website-ping.js";

describe("website ping", () => {
  it("pulls the named site once a minute at most and always answers 202", async () => {
    const pulled: string[] = [];
    const app = express().use("/api", websitePingRoutes((id) => pulled.push(id)));
    const site = "6F9619FF-8B86-4D01-B42D-00CF4FC964FF";
    await request(app).post(`/api/website-ping/${site}`).expect(202);
    await request(app).post(`/api/website-ping/${site}`).expect(202);
    await request(app).post("/api/website-ping/not-a-site").expect(202);
    expect(pulled).toEqual([site.toLowerCase()]);
  });

  it("treats upper- and mixed-case variants of a site id as the same site", async () => {
    const pulled: string[] = [];
    const app = express().use("/api", websitePingRoutes((id) => pulled.push(id)));
    const site = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
    for (const variant of [site, site.toUpperCase(), "6F9619ff-8B86-4d01-B42D-00cf4FC964ff", "6f9619FF-8b86-4D01-b42d-00CF4fc964FF"]) {
      await request(app).post(`/api/website-ping/${variant}`).expect(202);
    }
    expect(pulled).toEqual([site]);
  });
});
