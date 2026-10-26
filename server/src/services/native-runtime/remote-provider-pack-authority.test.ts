import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeSha256 } from "./canonical.js";
import { remoteProviderPackAuthority } from "./remote-provider-pack-authority.js";

describe("remote provider pack authority", () => {
  it("reattaches with the verified manifest after its local source disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-provider-authority-"));
    const binding = { companyId: "company-a", runId: "run-a", workspaceId: "workspace-a" };
    const payload = { target: "linux-x64", artifacts: { node: "sha256:test" } };
    const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", digest: `sha256:${nativeSha256(payload)}`, payload };
    try {
      const first = remoteProviderPackAuthority({ stateDirectory: root, binding, reattach: false, current: () => manifest });
      first.recordVerified();
      const resumed = remoteProviderPackAuthority({
        stateDirectory: root, binding, reattach: true,
        current: () => { throw new Error("local source removed"); },
      });
      expect(resumed.manifest).toEqual(manifest);
      expect(() => remoteProviderPackAuthority({
        stateDirectory: root, binding: { ...binding, companyId: "company-b" }, reattach: true,
        current: () => manifest,
      })).toThrow("saved provider pack authority is invalid");

      const path = join(root, "remote-provider-pack-authority.json");
      const saved = JSON.parse(await readFile(path, "utf8"));
      saved.manifest.payload.target = "other-target";
      await writeFile(path, JSON.stringify(saved));
      expect(() => remoteProviderPackAuthority({ stateDirectory: root, binding, reattach: true, current: () => manifest }))
        .toThrow("saved provider pack authority is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
