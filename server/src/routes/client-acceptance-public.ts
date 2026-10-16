import { Router } from "express";
import type { Db } from "@greatstone/db";
import { acceptClientEngagementSchema, type AcceptClientEngagement } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import type { StorageService } from "../storage/types.js";
import { contentDispositionHeader, isInlineAttachmentContentType, SVG_CONTENT_TYPE } from "../attachment-types.js";
import { HttpError, notFound } from "../errors.js";
import { clientAcceptanceService } from "../services/client-acceptance.js";
import { pipelineCaseFilesService } from "../services/pipeline-case-files.js";

// The client's side of online acceptance (John's yes, 16 Oct). These routes
// need no sign-in: the 256-bit token in the path is the only key, and it
// reaches one client's engagement pack and nothing else. They return only the
// two names, the pack and the acceptance itself.
export function clientAcceptancePublicRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = clientAcceptanceService(db);
  const filesSvc = pipelineCaseFilesService(db);

  const noStore = (res: { setHeader: (name: string, value: string) => void }) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  };

  router.get("/client-acceptance/:token", async (req, res) => {
    noStore(res);
    res.json(await svc.view(req.params.token as string));
  });

  router.get("/client-acceptance/:token/pack", async (req, res, next) => {
    noStore(res);
    const pack = await svc.pack(req.params.token as string);
    if (!storage) throw new HttpError(503, "File storage is not available");
    const upload = await filesSvc.getUpload(pack.companyId, pack.caseId, pack.evidenceId);
    if (!upload) throw notFound("The engagement pack is not available");
    const object = await storage.getObject(upload.companyId, upload.objectKey);
    const contentType = upload.contentType || object.contentType || "application/octet-stream";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const inlineSafe = mediaType !== SVG_CONTENT_TYPE && isInlineAttachmentContentType(mediaType);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(upload.byteSize || object.contentLength || 0));
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!inlineSafe) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader(
      "Content-Disposition",
      contentDispositionHeader(inlineSafe && req.query.download !== "1" ? "inline" : "attachment", upload.originalFilename ?? "engagement-pack"),
    );
    object.stream.on("error", (err) => next(err));
    object.stream.pipe(res);
  });

  router.post("/client-acceptance/:token/accept", validate(acceptClientEngagementSchema), async (req, res) => {
    noStore(res);
    const token = req.params.token as string;
    await svc.accept(token, req.body as AcceptClientEngagement, {
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.json(await svc.view(token));
  });

  return router;
}
