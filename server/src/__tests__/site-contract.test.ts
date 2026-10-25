// GSAM's side of the GSAM and website contract (GRE-2633). The website runs
// the same fixtures against its own code; a change here that breaks the other
// side fails one of the two CIs before merge.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEEP_DIVE_SYNC_SCHEMA,
  SITE_CONTRACT_MIN_SITE_VERSION,
  SITE_CONTRACT_NAME,
  SITE_CONTRACT_VERSION,
  WEBSITE_EDITOR_CONTRACT,
  WEBSITE_EDITOR_COPY_CONTRACT,
  WEBSITE_FRAME_PROTOCOLS,
  isSiteContractCurrent,
  isWebsiteEditorContractCurrent,
  websiteDocumentRequestAnswerSchema,
  websiteEditorHasCopyMode,
  websiteFrameHelloAckSchema,
} from "@greatstone/shared";
import { BRIDGE_SCHEME, BRIDGE_SCHEME_V2, bridgeHealthSchema, bridgeSyncAckSchema } from "../services/website/data-bridge-client.js";
import { WEBSITE_MIN_ENGINE_VERSION, checkWebsiteConnection } from "../services/website/connect-check.js";
import { WEBSITE_RELEASE_SCHEMA } from "../services/website/publish.js";
import { fakeNetlifyConnect } from "./helpers/fake-netlify-connect.js";
import { contractErrors, contractFixture, siteContractManifest as manifest } from "./helpers/site-contract.js";

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));

describe("GSAM and website contract (GRE-2633)", () => {
  it("GSAM's constants are the manifest's", () => {
    expect(manifest.name).toBe(SITE_CONTRACT_NAME);
    expect(manifest.version).toBe(SITE_CONTRACT_VERSION);
    expect(manifest.minSiteVersion).toBe(SITE_CONTRACT_MIN_SITE_VERSION);
    expect(manifest.surfaces.bridgeHealth!.schemes).toEqual([BRIDGE_SCHEME, BRIDGE_SCHEME_V2]);
    expect(manifest.surfaces.editorHelloAck).toMatchObject({
      frameProtocols: [...WEBSITE_FRAME_PROTOCOLS],
      editorContract: WEBSITE_EDITOR_CONTRACT,
      editorCopyContract: WEBSITE_EDITOR_COPY_CONTRACT,
    });
    expect(manifest.surfaces.release).toMatchObject({ releaseSchemas: [WEBSITE_RELEASE_SCHEMA], minEngineVersion: WEBSITE_MIN_ENGINE_VERSION });
    expect(manifest.surfaces.deepDiveSync!.syncSchema).toBe(DEEP_DIVE_SYNC_SCHEMA);
  });

  it("every fixture passes its own schema", () => {
    for (const [surface, spec] of Object.entries(manifest.surfaces)) {
      if (!spec.schema) continue;
      expect(contractErrors(surface, contractFixture(surface)), surface).toBeNull();
    }
  });

  it("each schema refuses a site answer with no siteContract", () => {
    for (const surface of ["bridgeHealth", "editorHelloAck", "release"]) {
      const { siteContract: _dropped, ...old } = contractFixture(surface);
      expect(contractErrors(surface, old), surface).toMatch(/siteContract/);
    }
  });

  it("GSAM reads the site's fixtures: bridge health, hello-ack and /_release", async () => {
    const health = bridgeHealthSchema.parse(contractFixture("bridgeHealth"));
    expect(isSiteContractCurrent(health)).toBe(true);

    const ack = websiteFrameHelloAckSchema.parse(contractFixture("editorHelloAck"));
    expect(isSiteContractCurrent(ack)).toBe(true);
    expect(isWebsiteEditorContractCurrent(ack)).toBe(true);
    expect(websiteEditorHasCopyMode(ack)).toBe(true);

    const { fetchImpl } = fakeNetlifyConnect({ release: { status: 200, body: contractFixture("release") } });
    await expect(checkWebsiteConnection({ netlifySiteId: "netlify-site", domain: "www.check.test", token: "nfp_token" }, { fetchImpl }))
      .resolves.toMatchObject({ ok: true });
  });

  it("GSAM reads the site's Deep Dive answer and call back", () => {
    expect(bridgeSyncAckSchema.parse(contractFixture("deepDiveSyncAck")).ok).toBe(true);
    expect(websiteDocumentRequestAnswerSchema.safeParse(contractFixture("documentRequestAnswer")).success).toBe(true);
  });

  describe("release gate (scripts/greatstone-site-contract-gate.mjs)", () => {
    type Gate = {
      siteOrigins: (sites: unknown[]) => string[];
      siteContractGate: (input: { manifest: unknown; origins: string[]; fetchImpl: typeof fetch }) => Promise<{ ok: boolean; line: string }>;
      connectedSites: (base: string, key: string, fetchImpl: typeof fetch) => Promise<unknown[]>;
    };
    const gate = () => import(new URL("../../../scripts/greatstone-site-contract-gate.mjs", import.meta.url).href) as Promise<Gate>;
    const sites = (answers: Record<string, unknown>) =>
      (async (input: string | URL) => {
        const url = new URL(String(input));
        const answer = answers[url.origin];
        if (answer === undefined) throw new TypeError("fetch failed");
        return typeof answer === "string" ? new Response(answer, { status: 200 }) : Response.json(answer);
      }) as unknown as typeof fetch;

    it("asks each site's live address and editor host once", async () => {
      const { siteOrigins } = await gate();
      expect(siteOrigins([
        { domain: "WWW.Site.test", editorFrameOrigin: "https://editor.site.test/" },
        { domain: "www.site.test", editorFrameOrigin: null },
      ])).toEqual(["https://editor.site.test", "https://www.site.test"]);
    });

    it("passes when every site speaks the release's minimum, and refuses an old or silent one", async () => {
      const { siteContractGate } = await gate();
      const origins = ["https://editor.site.test", "https://www.site.test"];
      const current = await siteContractGate({ manifest, origins, fetchImpl: sites({
        "https://editor.site.test": contractFixture("release"), "https://www.site.test": contractFixture("release"),
      }) });
      expect(current.ok).toBe(true);

      const { siteContract: _dropped, ...old } = contractFixture("release");
      const refused = await siteContractGate({ manifest, origins, fetchImpl: sites({ "https://www.site.test": old }) });
      expect(refused.ok).toBe(false);
      expect(refused.line).toContain("Out of date: update the website.");
      expect(refused.line).toContain("https://editor.site.test did not answer");
      expect(refused.line).toContain("https://www.site.test reports no siteContract");

      const html = await siteContractGate({ manifest, origins: ["https://www.site.test"], fetchImpl: sites({ "https://www.site.test": "<!doctype html>" }) });
      expect(html.line).toContain("has no /_release");
      expect((await siteContractGate({ manifest: { ...manifest, minSiteVersion: 2 }, origins: ["https://www.site.test"],
        fetchImpl: sites({ "https://www.site.test": contractFixture("release") }) })).line).toContain("speaks v1");
    });

    it("passes with no connected site, and lists sites across companies", async () => {
      const { connectedSites, siteContractGate } = await gate();
      expect((await siteContractGate({ manifest, origins: [], fetchImpl: sites({}) })).ok).toBe(true);
      const live = (async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/companies") return Response.json([{ id: "a" }, { id: "b" }]);
        if (path === "/api/companies/a/website/sites") return Response.json([{ domain: "a.test", editorFrameOrigin: null }]);
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;
      expect(await connectedSites("http://live.test", "", live)).toEqual([{ domain: "a.test", editorFrameOrigin: null }]);
    });
  });

  describe("contracts/check.mjs", () => {
    const run = (dir: string, ...args: string[]) => {
      try {
        return { code: 0, out: execFileSync("node", [path.join(dir, "check.mjs"), ...args], { encoding: "utf8", stdio: "pipe" }) };
      } catch (error) {
        const failed = error as { status: number; stderr: string };
        return { code: failed.status, out: failed.stderr };
      }
    };
    const copy = () => {
      const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "site-contract-")), "contracts");
      cpSync(CONTRACTS, dir, { recursive: true });
      return dir;
    };

    it("passes on the folder as committed", () => {
      expect(run(CONTRACTS)).toMatchObject({ code: 0 });
    });

    it("fails on a hand edit, a secret, and a site that speaks another version", () => {
      const dir = copy();
      try {
        expect(run(dir, "--site-speaks", String(manifest.version))).toMatchObject({ code: 0 });
        expect(run(dir, "--site-speaks", String(manifest.version - 1)).code).toBe(1);

        writeFileSync(path.join(dir, "site-contract/fixtures/bridge-error.json"), '{ "error": { "code": "replay" } }\n');
        expect(run(dir)).toMatchObject({ code: 1, out: expect.stringContaining("edited by hand") });

        writeFileSync(path.join(dir, "notes.txt"), "token nfp_abcdefghijklmnopqrstuvwx\n");
        run(dir, "--write");
        expect(run(dir)).toMatchObject({ code: 1, out: expect.stringContaining("a Netlify token") });
      } finally {
        rmSync(path.dirname(dir), { recursive: true, force: true });
      }
    });

    it("a vendored copy refuses --write", () => {
      const dir = copy();
      try {
        writeFileSync(path.join(dir, "VENDORED.json"), JSON.stringify({ commit: "0".repeat(40), version: manifest.version, contentHash: manifest.contentHash }));
        expect(run(dir)).toMatchObject({ code: 0 });
        expect(run(dir, "--write")).toMatchObject({ code: 1, out: expect.stringContaining("vendored copy") });
      } finally {
        rmSync(path.dirname(dir), { recursive: true, force: true });
      }
    });
  });
});
