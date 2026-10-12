import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  type HeartbeatRunScratch,
} from "../services/run-scratch.js";
import { validateToolContent } from "../services/tool-content-guards.js";
import { sealToolResultProxyPaths } from "../services/tool-result-sealed-values.js";

// GRE-1007: the Netlify `deploy-site` result carries its upload token in the
// proxy-path URL. Result redaction masked it, so agents could not deploy.
const PROXY_TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJzaXRlSWQiOiJzaXRlLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLWZvci10ZXN0";
const PROXY_URL = `https://netlify-mcp.netlify.app/proxy/${PROXY_TOKEN}`;

function deploySiteResult() {
  return {
    content: [
      {
        type: "text",
        text: `To deploy, run:\nnpx -y @netlify/mcp@latest --site-id site-123 --proxy-path "${PROXY_URL}"`,
      },
    ],
  };
}

function resultText(value: unknown): string {
  return (value as { content: Array<{ text: string }> }).content[0]!.text;
}

describe("tool result proxy-path sealing", () => {
  let scratch: HeartbeatRunScratch | null = null;

  afterEach(async () => {
    if (scratch) await cleanupHeartbeatRunScratch({ scratch });
    scratch = null;
  });

  it("hands the deploy command to the run's shell without showing the token", async () => {
    const runId = randomUUID();
    scratch = await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId,
      issueIdentifier: "GRE-1007",
    });

    const sealed = await sealToolResultProxyPaths(deploySiteResult(), { runId });
    const shown = resultText(
      validateToolContent({ value: sealed, direction: "result", sensitiveMode: "redact", promptInjectionMode: "block" })
        .value,
    );

    expect(shown).not.toContain(PROXY_TOKEN);
    expect(shown).not.toContain("REDACTED");
    expect(shown).toContain(`$(cat "${scratch.dir}/.gsam-sealed/netlify-proxy-path-`);

    const file = /\$\(cat "([^"]+)"\)/.exec(shown)![1]!;
    expect(await fs.readFile(file, "utf8")).toBe(PROXY_URL);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    // The command the agent sees resolves to the real proxy URL in a shell.
    const command = shown.split("\n")[1]!.replace("npx -y @netlify/mcp@latest", "printf '%s\\n'");
    const argv = execFileSync("sh", ["-c", command], { encoding: "utf8" }).trim().split("\n");
    expect(argv).toEqual(["--site-id", "site-123", "--proxy-path", PROXY_URL]);
  });

  it("leaves the token masked when the run has no local scratch dir", async () => {
    const sealed = await sealToolResultProxyPaths(deploySiteResult(), { runId: randomUUID() });
    const shown = resultText(validateToolContent({ value: sealed, direction: "result" }).value);
    expect(shown).not.toContain(PROXY_TOKEN);
    expect(shown).toContain("/proxy/***REDACTED***");
  });

  it("stops resolving a run's scratch dir after cleanup", async () => {
    const runId = randomUUID();
    scratch = await prepareHeartbeatRunScratch({ companyId: "c", agentId: "a", runId });
    await cleanupHeartbeatRunScratch({ scratch });
    scratch = null;
    const sealed = await sealToolResultProxyPaths(deploySiteResult(), { runId });
    expect(resultText(sealed)).toContain(PROXY_URL);
  });

  it("does not touch results without a Netlify proxy URL", async () => {
    const value = { content: [{ type: "text", text: "https://example.com/proxy/abc" }] };
    expect(await sealToolResultProxyPaths(value, { runId: "run-1" })).toBe(value);
  });
});
