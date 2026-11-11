import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { cases } from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  deepDiveOverview,
  deepDiveStreamKeyOf,
  deepDiveUnplacedPeople,
  readDeepDiveStreamFields,
  type DeepDiveOverview,
} from "@greatstone/shared";
import { loadDeepDiveRecord, type DeepDiveScope } from "./deep-dive-scope.js";
import { deepDiveBoardsService } from "./deep-dive-boards.js";
import { deepDiveFindingsService } from "./deep-dive-findings.js";
import { deepDiveSessionsService } from "./deep-dive-sessions.js";
import { deepDiveTraceabilityService } from "./deep-dive-traceability.js";
import { pipelineCaseDocumentRequestsService } from "./pipeline-case-document-requests.js";

// Deep Dive overview (GRE-2372): Screen 1 of the GRE-2327 plan. Holds no data
// of its own and writes nothing: it reads the streams (Cases), findings,
// sessions, document requests, organisation board and traceability chain,
// then deepDiveOverview in @greatstone/shared works out what is next.

export function deepDiveOverviewService(db: Db) {
  const findingsSvc = deepDiveFindingsService(db);
  const sessions = deepDiveSessionsService(db);
  const boards = deepDiveBoardsService(db);
  const trace = deepDiveTraceabilityService(db);
  const requests = pipelineCaseDocumentRequestsService(db);

  return {
    async overview(scope: DeepDiveScope, now = new Date()): Promise<DeepDiveOverview> {
      const companyId = scope.companyId;
      const [record, items, findings, sessionList, chain, org] = await Promise.all([
        loadDeepDiveRecord(db, companyId, scope.recordCaseId),
        db.select({ id: cases.id, key: cases.key, fields: cases.fields })
          .from(cases)
          .where(and(
            eq(cases.companyId, companyId),
            eq(cases.caseType, DEEP_DIVE_CASE_TYPES.stream),
            eq(cases.parentCaseId, scope.recordCaseId),
          )),
        findingsSvc.list(scope, {}),
        sessions.list(scope),
        trace.chain(scope),
        boards.orgBoard(scope),
      ]);

      const documentRequests = record?.clientCaseId ? await requests.list(companyId, record.clientCaseId) : [];

      return deepDiveOverview(companyId, {
        now,
        recordExists: true,
        northStarWords: chain.northStar?.words ?? "",
        clientChosen: !!record?.clientCaseId,
        streams: items.flatMap((item) => {
          const stream = deepDiveStreamKeyOf(item);
          return stream ? [{ caseId: item.id, fields: readDeepDiveStreamFields(stream, item.fields) }] : [];
        }),
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
