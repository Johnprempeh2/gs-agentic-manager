// Every card needs an organisation (GRE-1538). Suites that are not about
// organisations use these helpers so each card they create gets one test
// organisation per company. The rule itself is tested in
// pipelines-case-organisation.test.ts, without these helpers.
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { pipelines, type createDb } from "@greatstone/db";
import { findOrCreateOrganisation } from "../../services/organisation-match.js";

type TestDb = ReturnType<typeof createDb>;

export async function testOrganisationId(db: TestDb, companyId: string) {
  const organisation = await findOrCreateOrganisation(db, { companyId, name: "Test organisation" });
  return organisation!.id;
}

type CaseInput = { companyId: string; organisationId?: string | null; parentCaseId?: string | null };

async function withOrganisation<T extends CaseInput>(db: TestDb, input: T): Promise<T> {
  // A child inherits its parent's organisation; leave that path to the service.
  if (input.organisationId !== undefined || input.parentCaseId) return input;
  return { ...input, organisationId: await testOrganisationId(db, input.companyId) };
}

/** The pipeline service, with a test organisation on each created case that names none. */
export function withTestOrganisations<
  S extends {
    ingestCase(input: CaseInput & Record<string, unknown>): Promise<unknown>;
    ingestCases(input: { companyId: string; items: Array<Omit<CaseInput, "companyId">> } & Record<string, unknown>): Promise<unknown>;
  },
>(svc: S, db: TestDb): S {
  return Object.assign(Object.create(svc), {
    ingestCase: async (input: Parameters<S["ingestCase"]>[0]) => svc.ingestCase(await withOrganisation(db, input)),
    ingestCases: async (input: Parameters<S["ingestCases"]>[0]) => {
      const organisationId = await testOrganisationId(db, input.companyId);
      return svc.ingestCases({
        ...input,
        items: input.items.map((item) =>
          item.organisationId !== undefined || item.parentCaseId ? item : { ...item, organisationId }),
      });
    },
  }) as S;
}

const CASE_CREATE_PATH = /^\/pipelines\/([^/]+)\/cases(\/batch)?$/;

/** Express middleware for route suites: fills organisationId on case-create bodies that name none. */
export function fillTestCaseOrganisation(db: TestDb) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const match = req.method === "POST" ? CASE_CREATE_PATH.exec(req.path) : null;
      if (!match || !req.body || typeof req.body !== "object") return next();
      const [pipeline] = await db
        .select({ companyId: pipelines.companyId })
        .from(pipelines)
        .where(eq(pipelines.id, match[1]!))
        .catch(() => []);
      if (!pipeline) return next();
      const organisationId = await testOrganisationId(db, pipeline.companyId);
      const fill = (item: Record<string, unknown>) =>
        item.organisationId !== undefined || item.parentCaseId ? item : { ...item, organisationId };
      if (match[2] && Array.isArray(req.body.items)) req.body.items = req.body.items.map(fill);
      else if (!match[2]) req.body = fill(req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}
