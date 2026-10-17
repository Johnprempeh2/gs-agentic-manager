import { sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import type { CompanyQuietClient, CompanyQuietClientsResponse } from "@greatstone/shared";

interface QuietClientRow {
  caseId: string;
  title: string;
  pipelineId: string;
  pipelineName: string;
  stageName: string;
  organisationName: string | null;
  lastTouchAt: Date | string | null;
  lastTouchKind: string | null;
  lastTouchSubject: string | null;
  addedAt: Date | string;
  total: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function touchLabel(kind: string | null, subject: string | null): string | null {
  if (!kind) return null;
  const words = kind.replace(/_/g, " ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  const what = subject?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!what) return label;
  return `${label}: ${what.length > 80 ? `${what.slice(0, 79)}…` : what}`;
}

/**
 * Open deals and leads with no note, call, meeting or email (on the deal or
 * its organisation) for `days` days, quietest first. Stage changes do not
 * count as contact.
 */
export function quietClientsService(db: Db) {
  return {
    list: async (
      companyId: string,
      options: { days: number; limit: number; now?: Date },
    ): Promise<CompanyQuietClientsResponse> => {
      const now = options.now ?? new Date();
      const cutoff = new Date(now.getTime() - options.days * DAY_MS);
      const rows = await db.execute(sql`
        WITH open_cases AS (
          SELECT pc.id, pc.title, pc.pipeline_id, pc.organisation_id, pc.created_at,
            p.name AS pipeline_name, st.name AS stage_name, o.name AS organisation_name
          FROM pipeline_cases pc
          JOIN pipelines p ON p.id = pc.pipeline_id AND p.archived_at IS NULL
          JOIN pipeline_stages st ON st.id = pc.stage_id AND st.kind IN ('working', 'review')
          LEFT JOIN organisations o ON o.id = pc.organisation_id AND o.archived_at IS NULL
          WHERE pc.company_id = ${companyId}
            AND pc.retired_at IS NULL
            AND pc.terminal_at IS NULL
            AND pc.hidden_from_board_at IS NULL
        ),
        touched AS (
          SELECT oc.*, last.occurred AS last_touch_at, last.kind AS last_touch_kind, last.subject AS last_touch_subject
          FROM open_cases oc
          LEFT JOIN LATERAL (
            SELECT coalesce(te.occurred_at, te.created_at) AS occurred,
              coalesce(te.activity_type, te.kind) AS kind,
              coalesce(nullif(te.subject, ''), te.body) AS subject
            FROM crm_timeline_entries te
            WHERE te.company_id = ${companyId}
              AND te.kind <> 'stage_change'
              AND (te.case_id = oc.id OR (oc.organisation_id IS NOT NULL AND te.organisation_id = oc.organisation_id))
            ORDER BY coalesce(te.occurred_at, te.created_at) DESC
            LIMIT 1
          ) last ON true
        )
        SELECT id AS "caseId", title, pipeline_id AS "pipelineId", pipeline_name AS "pipelineName",
          stage_name AS "stageName", organisation_name AS "organisationName",
          last_touch_at AS "lastTouchAt", last_touch_kind AS "lastTouchKind",
          last_touch_subject AS "lastTouchSubject", created_at AS "addedAt",
          count(*) OVER ()::int AS total
        FROM touched
        WHERE coalesce(last_touch_at, created_at) < ${cutoff.toISOString()}
        ORDER BY coalesce(last_touch_at, created_at) ASC, id
        LIMIT ${options.limit}
      `) as unknown as QuietClientRow[];

      const prefixRows = await db.execute(sql`SELECT issue_prefix AS "issuePrefix" FROM companies WHERE id = ${companyId}`) as unknown as Array<{ issuePrefix: string | null }>;
      const prefix = prefixRows[0]?.issuePrefix?.trim() || "company";

      const clients: CompanyQuietClient[] = rows.map((row) => {
        const since = iso(row.lastTouchAt) ?? iso(row.addedAt)!;
        return {
          caseId: row.caseId,
          title: row.title,
          pipelineId: row.pipelineId,
          pipelineName: row.pipelineName,
          stageName: row.stageName,
          organisationName: row.organisationName,
          lastTouchAt: iso(row.lastTouchAt),
          lastTouchLabel: touchLabel(row.lastTouchKind, row.lastTouchSubject),
          quietDays: Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY_MS)),
          href: `/${prefix}/pipelines/${row.pipelineId}/items/${row.caseId}`,
        };
      });
      return { days: options.days, clients, total: Number(rows[0]?.total ?? 0) };
    },
  };
}
