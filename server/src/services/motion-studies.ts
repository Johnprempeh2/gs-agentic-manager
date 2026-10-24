import { and, asc, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, motionStudies } from "@greatstone/db";
import {
  isTextSafeTheme,
  type CreateMotionStudy,
  type ImportMotionStudies,
  type ImportMotionStudiesResult,
  type MotionStudiesQuery,
  type MotionStudy,
  type MotionStudyDecision,
  type MotionStudyPosterType,
  type MotionStudySource,
  type MotionStudyStatus,
  type UpdateMotionStudy,
} from "@greatstone/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";

// Motion studies (GRE-2212). Each study page is stored as a company asset and
// served by the motion-studies routes inside a sandbox with no network, so a
// study can run its own scripts but cannot reach anything outside itself.

export type MotionStudyRow = typeof motionStudies.$inferSelect;

export interface MotionStudyActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
}

type StudyFields = {
  number?: string;
  slug: string;
  title: string;
  concept?: string;
  theme?: string[];
  tech?: string;
  notes?: string | null;
  studyDate?: string | null;
  sourceUrl?: string | null;
  html: string;
  textSafe?: boolean;
  poster?: { contentType: MotionStudyPosterType; dataBase64: string } | null;
};

export const MOTION_STUDY_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * The page may run its own inline scripts, styles, canvases and workers and
 * nothing else: no requests out, no forms, no top-level navigation, no
 * access to GSAM (the sandbox gives it an opaque origin).
 */
export const MOTION_STUDY_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export function padStudyNumber(value: string | number): string {
  return String(value).trim().padStart(3, "0");
}

export function toMotionStudy(row: MotionStudyRow): MotionStudy {
  const hasProposal = row.proposedStatus !== null || row.proposedDecision !== null;
  return {
    id: row.id,
    companyId: row.companyId,
    number: row.number,
    slug: row.slug,
    title: row.title,
    concept: row.concept,
    theme: Array.isArray(row.theme) ? row.theme : [],
    tech: row.tech,
    notes: row.notes,
    studyDate: row.studyDate,
    sourceUrl: row.sourceUrl,
    textSafe: row.textSafe,
    status: row.status as MotionStudyStatus,
    decision: row.decision as MotionStudyDecision,
    proposal: hasProposal
      ? {
          status: (row.proposedStatus as MotionStudyStatus | null) ?? null,
          decision: (row.proposedDecision as MotionStudyDecision | null) ?? null,
          reason: row.proposalReason,
          agentId: row.proposedByAgentId,
          proposedAt: (row.proposedAt ?? row.updatedAt).toISOString(),
        }
      : null,
    source: row.source as MotionStudySource,
    assetId: row.assetId,
    previewPath: row.assetId ? `/api/motion-studies/${row.id}/preview` : null,
    posterAssetId: row.posterAssetId,
    // The asset id in the path changes with a new poster, so the browser can cache each one for long.
    posterPath: row.posterAssetId ? `/api/motion-studies/${row.id}/poster?v=${row.posterAssetId}` : null,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function studyFilename(slug: string) {
  return `${slug}.html`;
}

const POSTER_EXTENSIONS: Record<MotionStudyPosterType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function motionStudyService(db: Db, storage: StorageService) {
  async function storeFile(
    companyId: string,
    file: { filename: string; contentType: string; body: Buffer },
    actor: MotionStudyActor,
  ) {
    const stored = await storage.putFile({
      companyId,
      namespace: "assets/motion-studies",
      originalFilename: file.filename,
      contentType: file.contentType,
      body: file.body,
    });
    const [asset] = await db
      .insert(assets)
      .values({
        companyId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      })
      .returning();
    return asset!;
  }

  function storeHtml(companyId: string, slug: string, html: string, actor: MotionStudyActor) {
    return storeFile(
      companyId,
      { filename: studyFilename(slug), contentType: MOTION_STUDY_CONTENT_TYPE, body: Buffer.from(html, "utf8") },
      actor,
    );
  }

  /** The poster's asset id, or undefined when none was given (an import then keeps the one it has). */
  async function storePoster(companyId: string, fields: StudyFields, actor: MotionStudyActor) {
    if (!fields.poster) return undefined;
    const asset = await storeFile(
      companyId,
      {
        filename: `${fields.slug}-poster.${POSTER_EXTENSIONS[fields.poster.contentType]}`,
        contentType: fields.poster.contentType,
        body: Buffer.from(fields.poster.dataBase64, "base64"),
      },
      actor,
    );
    return asset.id;
  }

  async function readAsset(companyId: string, assetId: string | null) {
    if (!assetId) return null;
    const asset = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .then((rows) => rows[0] ?? null);
    if (!asset || asset.companyId !== companyId) return null;
    const object = await storage.getObject(asset.companyId, asset.objectKey);
    return { asset, stream: object.stream };
  }

  async function nextNumber(companyId: string): Promise<string> {
    const rows = await db
      .select({ number: motionStudies.number })
      .from(motionStudies)
      .where(eq(motionStudies.companyId, companyId));
    const highest = rows.reduce((max, row) => Math.max(max, Number.parseInt(row.number, 10) || 0), 0);
    return padStudyNumber(highest + 1);
  }

  function catalogueFields(fields: StudyFields) {
    const theme = fields.theme ?? [];
    return {
      slug: fields.slug,
      title: fields.title,
      concept: fields.concept ?? "",
      theme,
      tech: fields.tech ?? "",
      notes: fields.notes ?? null,
      studyDate: fields.studyDate ?? null,
      sourceUrl: fields.sourceUrl ?? null,
      textSafe: fields.textSafe ?? isTextSafeTheme(theme),
    };
  }

  async function getBySlug(companyId: string, slug: string) {
    return db
      .select()
      .from(motionStudies)
      .where(and(eq(motionStudies.companyId, companyId), eq(motionStudies.slug, slug)))
      .then((rows) => rows[0] ?? null);
  }

  return {
    getById: (id: string) =>
      db
        .select()
        .from(motionStudies)
        .where(eq(motionStudies.id, id))
        .then((rows) => rows[0] ?? null),

    async list(companyId: string, query: MotionStudiesQuery): Promise<MotionStudy[]> {
      const conditions: SQL[] = [eq(motionStudies.companyId, companyId)];
      if (query.status) conditions.push(eq(motionStudies.status, query.status));
      if (query.decision) conditions.push(eq(motionStudies.decision, query.decision));
      if (query.textSafe !== undefined) conditions.push(eq(motionStudies.textSafe, query.textSafe));
      if (query.q) {
        const pattern = `%${query.q.replace(/[%_\\]/g, "\\$&")}%`;
        conditions.push(or(ilike(motionStudies.title, pattern), ilike(motionStudies.concept, pattern))!);
      }
      const rows = await db
        .select()
        .from(motionStudies)
        .where(and(...conditions))
        .orderBy(desc(motionStudies.number), asc(motionStudies.title));
      return rows.map(toMotionStudy);
    },

    /** One new study. It always starts as New and Undecided, whoever adds it. */
    async create(companyId: string, input: CreateMotionStudy & { html: string }, actor: MotionStudyActor) {
      if (await getBySlug(companyId, input.slug)) {
        throw conflict(`A study called "${input.slug}" is already in Motion`);
      }
      const asset = await storeHtml(companyId, input.slug, input.html, actor);
      const posterAssetId = await storePoster(companyId, input as StudyFields, actor);
      const [row] = await db
        .insert(motionStudies)
        .values({
          companyId,
          number: input.number ? padStudyNumber(input.number) : await nextNumber(companyId),
          ...catalogueFields(input as StudyFields),
          status: "new",
          decision: "undecided",
          source: input.source ?? "manual",
          assetId: asset.id,
          posterAssetId: posterAssetId ?? null,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        })
        .returning();
      return row!;
    },

    /**
     * The one-off Lab import, matched by slug. A study already here keeps its
     * Status, Decision and any open proposal; its file and fields are refreshed.
     */
    async importStudies(
      companyId: string,
      input: ImportMotionStudies,
      actor: MotionStudyActor,
    ): Promise<ImportMotionStudiesResult> {
      const seen = new Set<string>();
      for (const study of input.studies) {
        if (seen.has(study.slug)) throw unprocessable(`The study "${study.slug}" is listed twice`);
        seen.add(study.slug);
      }
      let created = 0;
      let updated = 0;
      const rows: MotionStudyRow[] = [];
      for (const study of input.studies) {
        const asset = await storeHtml(companyId, study.slug, study.html, actor);
        const posterAssetId = await storePoster(companyId, study as StudyFields, actor);
        const fields = catalogueFields(study as StudyFields);
        const existing = await getBySlug(companyId, study.slug);
        if (existing) {
          const [row] = await db
            .update(motionStudies)
            .set({
              ...fields,
              number: padStudyNumber(study.number),
              assetId: asset.id,
              ...(posterAssetId ? { posterAssetId } : {}),
              updatedAt: new Date(),
            })
            .where(eq(motionStudies.id, existing.id))
            .returning();
          rows.push(row!);
          updated += 1;
        } else {
          const [row] = await db
            .insert(motionStudies)
            .values({
              companyId,
              number: padStudyNumber(study.number),
              ...fields,
              status: study.status ?? "new",
              decision: study.decision ?? "undecided",
              source: "lab_import",
              assetId: asset.id,
              posterAssetId: posterAssetId ?? null,
              createdByAgentId: actor.agentId,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            })
            .returning();
          rows.push(row!);
          created += 1;
        }
      }
      return { created, updated, studies: rows.map(toMotionStudy) };
    },

    /**
     * A person's change takes effect and clears any open proposal it answers.
     * An agent's Status or Decision becomes a proposal; its notes still save.
     */
    async update(row: MotionStudyRow, input: UpdateMotionStudy, actor: MotionStudyActor) {
      const now = new Date();
      const patch: Partial<typeof motionStudies.$inferInsert> = { updatedAt: now };
      if (input.notes !== undefined) patch.notes = input.notes;
      const proposes = actor.actorType === "agent";
      if (proposes) {
        if (input.status !== undefined || input.decision !== undefined) {
          // A field the agent leaves out keeps any open proposal for it, even another agent's.
          patch.proposedStatus =
            input.status === undefined ? row.proposedStatus : input.status !== row.status ? input.status : null;
          patch.proposedDecision =
            input.decision === undefined
              ? row.proposedDecision
              : input.decision !== row.decision
                ? input.decision
                : null;
          const changesSomething = patch.proposedStatus !== null || patch.proposedDecision !== null;
          patch.proposalReason = changesSomething ? (input.reason ?? null) : null;
          patch.proposedByAgentId = changesSomething ? actor.agentId : null;
          patch.proposedAt = changesSomething ? now : null;
        }
      } else {
        if (input.status !== undefined) patch.status = input.status;
        if (input.decision !== undefined) patch.decision = input.decision;
        if (input.status !== undefined || input.decision !== undefined) {
          Object.assign(patch, clearedProposal());
        }
      }
      const [updated] = await db.update(motionStudies).set(patch).where(eq(motionStudies.id, row.id)).returning();
      return { row: updated!, proposed: proposes && (patch.proposedStatus != null || patch.proposedDecision != null) };
    },

    /** A person accepts or declines an agent's open proposal. */
    async resolveProposal(row: MotionStudyRow, accept: boolean) {
      if (row.proposedStatus === null && row.proposedDecision === null) {
        throw notFound("This study has no open proposal");
      }
      const patch: Partial<typeof motionStudies.$inferInsert> = { ...clearedProposal(), updatedAt: new Date() };
      if (accept) {
        if (row.proposedStatus) patch.status = row.proposedStatus;
        if (row.proposedDecision) patch.decision = row.proposedDecision;
      }
      const [updated] = await db.update(motionStudies).set(patch).where(eq(motionStudies.id, row.id)).returning();
      return updated!;
    },

    readHtml: (row: MotionStudyRow) => readAsset(row.companyId, row.assetId),

    readPoster: (row: MotionStudyRow) => readAsset(row.companyId, row.posterAssetId),

    async remove(id: string) {
      await db.delete(motionStudies).where(eq(motionStudies.id, id));
    },
  };
}

function clearedProposal() {
  return {
    proposedStatus: null,
    proposedDecision: null,
    proposalReason: null,
    proposedByAgentId: null,
    proposedAt: null,
  };
}
