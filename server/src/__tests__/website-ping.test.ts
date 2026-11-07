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
});
