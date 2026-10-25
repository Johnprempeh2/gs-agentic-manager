import { describe, expect, it } from "vitest";
import { fakeNetlifyConnect } from "../../__tests__/helpers/fake-netlify-connect.js";
import { checkWebsiteConnection, domainBelongsToSite, engineVersionAtLeast } from "./connect-check.js";

const input = { netlifySiteId: "netlify-site", domain: "www.check.test", token: "nfp_token" };

describe("website connect check (GRE-2137)", () => {
  it("reads the engine version from the shape the site engine serves at /_release", async () => {
    const { fetchImpl } = fakeNetlifyConnect({
      release: { status: 200, body: { siteId: "x", number: 1, source: "baked", engine: { version: "0.1.0", commit: "0".repeat(40) }, supportedReleaseSchemas: [1], refused: null } },
    });
    await expect(checkWebsiteConnection(input, { fetchImpl })).resolves.toEqual({ ok: true, engineVersion: "0.1.0" });
  });

  it("an address that does not answer at all is connect.err.domain", async () => {
    const { fetchImpl } = fakeNetlifyConnect({ release: "unreachable" });
    await expect(checkWebsiteConnection(input, { fetchImpl })).resolves.toEqual({ ok: false, problem: "domain" });
  });

  it("an engine that does not read GSAM's release schema is connect.err.engine_old", async () => {
    const { fetchImpl } = fakeNetlifyConnect({ release: { status: 200, body: { engine: { version: "0.5.0" }, supportedReleaseSchemas: [2] } } });
    await expect(checkWebsiteConnection(input, { fetchImpl })).resolves.toEqual({ ok: false, problem: "engine_old", engineVersion: "0.5.0" });
  });

  it("matches the live address to the Netlify site's addresses", () => {
    const site = { name: "greatstone-home", custom_domain: "greatstoneint.com", domain_aliases: ["shop.greatstoneint.com"], ssl_url: "https://greatstoneint.com" };
    expect(domainBelongsToSite("greatstoneint.com", site)).toBe(true);
    expect(domainBelongsToSite("www.greatstoneint.com", site)).toBe(true);
    expect(domainBelongsToSite("shop.greatstoneint.com", site)).toBe(true);
    expect(domainBelongsToSite("greatstone-home.netlify.app", site)).toBe(true);
    expect(domainBelongsToSite("gsam-editor--greatstone-home.netlify.app", site)).toBe(true);
    expect(domainBelongsToSite("example.com", site)).toBe(false);
    expect(domainBelongsToSite("x--other-site.netlify.app", site)).toBe(false);
  });

  it("compares engine versions by number", () => {
    expect(engineVersionAtLeast("0.1.0")).toBe(true);
    expect(engineVersionAtLeast("0.10.0", "0.9.0")).toBe(true);
    expect(engineVersionAtLeast("v1.0.0-beta.1")).toBe(true);
    expect(engineVersionAtLeast("0.0.9")).toBe(false);
    expect(engineVersionAtLeast("next")).toBe(false);
  });
});
