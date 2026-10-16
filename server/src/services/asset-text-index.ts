import type { Readable } from "node:stream";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, assetTexts } from "@greatstone/db";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { canExtractFileText, extractFileText } from "./file-text.js";

/** Files above this size are not read for search. */
export const MAX_INDEXED_FILE_BYTES = 25 * 1024 * 1024;
/** Files read per round, newest first, so a backlog clears without a spike. */
const SWEEP_BATCH = 10;

async function readAll(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      stream.destroy();
      throw new Error("file too large to read");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Keeps the words of uploaded files (NDAs, engagement packs, chat
 * attachments) in `asset_texts` so search can find them and show the line.
 */
export function assetTextIndexService(db: Db, storage: StorageService) {
  type AssetRow = typeof assets.$inferSelect;

  async function index(asset: Pick<AssetRow, "id" | "companyId" | "objectKey" | "contentType" | "byteSize" | "originalFilename">) {
    const values = { assetId: asset.id, companyId: asset.companyId, extractedAt: new Date() };
    let row: { status: string; text: string | null; error: string | null };
    if (!canExtractFileText(asset.contentType, asset.originalFilename)) {
      row = { status: "unsupported", text: null, error: null };
    } else if (asset.byteSize > MAX_INDEXED_FILE_BYTES) {
      row = { status: "too_large", text: null, error: null };
    } else {
      try {
        const object = await storage.getObject(asset.companyId, asset.objectKey);
        const buffer = await readAll(object.stream, MAX_INDEXED_FILE_BYTES);
        const result = extractFileText(buffer, asset.contentType, asset.originalFilename);
        row = { status: result.status, text: result.text, error: result.status === "failed" ? result.error : null };
      } catch (error) {
        row = { status: "failed", text: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    await db
      .insert(assetTexts)
      .values({ ...values, ...row })
      .onConflictDoUpdate({ target: assetTexts.assetId, set: { ...row, extractedAt: values.extractedAt } });
    return row.status;
  }

  return {
    index,

    /** One round: read the newest files that have not been read yet. Returns how many were read. */
    async sweep(now = new Date(), batch = SWEEP_BATCH): Promise<number> {
      const pending = await db
        .select({
          id: assets.id,
          companyId: assets.companyId,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          originalFilename: assets.originalFilename,
        })
        .from(assets)
        .leftJoin(assetTexts, eq(assetTexts.assetId, assets.id))
        .where(and(isNull(assetTexts.assetId), lte(assets.createdAt, now)))
        .orderBy(desc(assets.createdAt))
        .limit(batch);
      for (const asset of pending) {
        try {
          await index(asset);
        } catch (error) {
          logger.warn({ err: error, assetId: asset.id }, "could not store the words of a file");
        }
      }
      return pending.length;
    },
  };
}
