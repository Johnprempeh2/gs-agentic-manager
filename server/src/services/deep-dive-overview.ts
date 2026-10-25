import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { cases } from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_RECORD_KEY,
  DEEP_DIVE_STREAMS,
  deepDiveOverview,
  deepDiveUnplacedPeople,
  readDeepDiveStreamFields,
  type DeepDiveOverview,
  type DeepDiveStreamKey,
} from "@greatstone/shared";
import { deepDiveBoardsService } from "./deep-dive-boards.js";
import { deepDiveFindingsService } from "./deep-dive-findings.js";
import { deepDiveSessionsService } from "./deep-dive-sessions.js";
import { deepDiveTraceabilityService } from "./deep-dive-traceability.js";
import { pipelineCaseDocumentRequestsService } from "./pipeline-case-document-requests.js";

// Deep Dive overview (GRE-2372): Screen 1 of the GRE-2327 plan. Holds no data
// of its own and writes nothing: it reads the streams (Cases), findings,
// sessions, document requests, organisation board and traceability chain,
// then deepDiveOverview in @greatstone/shared works out what is next.

const STREAM_KEYS = new Set<string>(DEEP_DIVE_STREAMS.map((s) => s.key));

export function deepDiveOverviewService(db: Db) {
  const findingsSvc = deepDiveFindingsService(db);
  const sessions = deepDiveSessionsService(db);
  const boards = deepDiveBoardsService(db);
  const trace = deepDiveTraceabilityService(db);
  const requests = pipelineCaseDocumentRequestsService(db);

  return {
    async overview(companyId: string, now = new Date()): Promise<DeepDiveOverview> {
      const [items, findings, sessionList, chain, org] = await Promise.all([
        db.select({ id: cases.id, caseType: cases.caseType, key: cases.key, fields: cases.fields, clientCaseId: cases.clientCaseId })
          .from(cases)
          .where(and(
            eq(cases.companyId, companyId),
            inArray(cases.caseType, [DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_CASE_TYPES.stream]),
          )),
        findingsSvc.list(companyId, {}),
        sessions.list(companyId),
        trace.chain(companyId),
        boards.orgBoard(companyId),
      ]);

      const record = items.find((item) => item.caseType === DEEP_DIVE_CASE_TYPES.record && item.key === DEEP_DIVE_RECORD_KEY) ?? null;
      const documentRequests = record?.clientCaseId ? await requests.list(companyId, record.clientCaseId) : [];

      return deepDiveOverview(companyId, {
        now,
        recordExists: !!record,
        northStarWords: chain.northStar?.words ?? "",
        clientChosen: !!record?.clientCaseId,
        streams: items
          .flatMap((item) => item.caseType === DEEP_DIVE_CASE_TYPES.stream && item.key && STREAM_KEYS.has(item.key)
            ? [{ caseId: item.id, fields: readDeepDiveStreamFields(item.key as DeepDiveStreamKey, item.fields) }]
            : []),
        findings,
        sessions: sessionList,
        documentRequests: documentRequests.map((r) => ({ id: r.id, title: r.title, held: !!r.received })),
        findingIdsInOpportunities: chain.opportunities.flatMap((o) => o.findingIds),
        // A missing North Star has its own step, so it is not counted again here.
        brokenLinkCount: chain.broken.filter((b) => b.step !== "north_star").length,
        unplacedPeopleCount: deepDiveUnplacedPeople(org.people, org.units).length,
      });
    },
  };
}
