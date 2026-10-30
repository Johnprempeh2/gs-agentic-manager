import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalDiskStorageProvider } from "../../server/src/storage/local-disk-provider.js";
import { createStorageService } from "../../server/src/storage/service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-readback-"));
  roots.push(root);
  return createStorageService(createLocalDiskStorageProvider(root));
}

async function bytes(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("private attachment readback", () => {
  it.each(["version 2 ..xlsx", "version 2 report.xlsx"])(
    "reads the exact uploaded bytes for %s",
    async (originalFilename) => {
      const storage = await fixture();
      const body = Buffer.from([0, 1, 2, 3, 0, 255, 4]);
      const stored = await storage.putFile({
        companyId: "company-1",
        namespace: "issues/issue-1",
        originalFilename,
        contentType: "application/octet-stream",
        body,
      });

      const object = await storage.getObject("company-1", stored.objectKey);
      const readback = await bytes(object.stream);
      expect(readback).toEqual(body);
      expect(createHash("sha256").update(readback).digest("hex")).toBe(stored.sha256);
      expect((await storage.headObject("company-1", stored.objectKey)).exists).toBe(true);
    },
  );

  it("reads an existing object key with consecutive dots in its filename", async () => {
    const storage = await fixture();
    const key = "company-1/issues/issue-1/2026/10/30/upload-version_2_..xlsx";
    const body = Buffer.from("synthetic workbook bytes");
    // A pre-fix upload wrote the object before readback validation rejected its key.
    const provider = createLocalDiskStorageProvider(roots[0]!);
    await provider.putObject({ objectKey: key, body, contentType: "application/octet-stream", contentLength: body.length });

    expect(await bytes((await storage.getObject("company-1", key)).stream)).toEqual(body);
    await storage.deleteObject("company-1", key);
    expect((await storage.headObject("company-1", key)).exists).toBe(false);
  });

  it("rejects cross-company reads and path traversal", async () => {
    const storage = await fixture();
    const key = "company-1/issues/issue-1/upload-version_2_..xlsx";
    await expect(storage.getObject("company-2", key)).rejects.toMatchObject({ status: 403 });
    for (const unsafe of ["company-1/issues/../secret", "company-1/issues/..\\secret"]) {
      await expect(storage.getObject("company-1", unsafe)).rejects.toMatchObject({ status: 400 });
    }
  });
});
