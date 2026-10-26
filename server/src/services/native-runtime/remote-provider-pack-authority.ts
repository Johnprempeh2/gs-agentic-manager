import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalNativeJson, nativeSha256 } from "./canonical.js";

const FILENAME = "remote-provider-pack-authority.json";
const SCHEMA = "greatstone.remote-provider-pack-authority.v1";
const MAX_BYTES = 512 * 1024;

type Manifest = { schema: string; digest: string; payload: unknown };

function assertManifest(value: unknown): asserts value is Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provider pack authority");
  const manifest = value as Partial<Manifest>;
  if (manifest.schema !== "paperclip-runner/remote-provider-pack/v1" ||
      manifest.digest !== `sha256:${nativeSha256(manifest.payload)}`) {
    throw new Error("invalid provider pack authority");
  }
}

/** A saved manifest is usable only for the exact remote run whose pack was verified. */
export function remoteProviderPackAuthority<T extends Manifest>(input: {
  stateDirectory: string;
  binding: Record<string, string>;
  reattach: boolean;
  current: () => T;
}): { manifest: T; recordVerified: () => void } {
  const root = lstatSync(input.stateDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("unsafe provider pack authority directory");
  const path = join(input.stateDirectory, FILENAME);
  let manifest: T | null = null;
  if (input.reattach) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("invalid authority file");
      const saved = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
      if (saved.schema !== SCHEMA || canonicalNativeJson(saved.binding) !== canonicalNativeJson(input.binding)) {
        throw new Error("provider pack authority binding mismatch");
      }
      assertManifest(saved.manifest);
      manifest = saved.manifest as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("runner_remote_provider_artifact_incompatible: saved provider pack authority is invalid", { cause: error });
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  manifest ??= input.current();
  assertManifest(manifest);
  const selected = structuredClone(manifest);
  const receipt = JSON.stringify({ schema: SCHEMA, binding: input.binding, manifest: selected });
  if (Buffer.byteLength(receipt) > MAX_BYTES) throw new Error("provider pack authority exceeds size limit");
  return {
    manifest: selected,
    recordVerified: () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, receipt, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
