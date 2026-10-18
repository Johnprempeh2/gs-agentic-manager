import { sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import type {
  CompanyClientActivity,
  CompanyQuietClient,
  CompanyQuietClientsResponse,
  CompanyRecentClientActivityResponse,
} from "@greatstone/shared";

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

interface ActivityRow {
  id: string;
  kind: string;
  subject: string | null;
  body: string | null;
  ownerName: string | null;
  occurredAt: Date | string;
  clientName: string | null;
  clientKey: string | null;
  path: string;
}

function kindLabel(kind: string): string {
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function plainText(text: string | null, max = 80): string {
  const plain = (text ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

async function routePrefix(db: Db, companyId: string): Promise<string> {
  const rows = await db.execute(sql`SELECT issue_prefix AS "issuePrefix" FROM companies WHERE id = ${companyId}`) as unknown as Array<{ issuePrefix: string | null }>;
  return rows[0]?.issuePrefix?.trim() || "company";
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

      const prefix = await routePrefix(db, companyId);

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

    /**
     * Imported notes, calls, meetings and emails from the last `days` days,
     * newest first, with the deal or organisation each belongs to.
     */
    recentActivity: async (
      companyId: string,
      options: { days: number; limit: number; now?: Date },
    ): Promise<CompanyRecentClientActivityResponse> => {
      const now = options.now ?? new Date();
      const since = new Date(now.getTime() - options.days * DAY_MS);
      const inWindow = sql`
        FROM crm_timeline_entries te
        LEFT JOIN pipeline_cases tc ON tc.id = te.case_id AND tc.retired_at IS NULL
        LEFT JOIN organisations torg ON torg.id = te.organisation_id AND torg.archived_at IS NULL
        WHERE te.company_id = ${companyId}
          AND te.kind <> 'stage_change'
          AND coalesce(te.occurred_at, te.created_at) >= ${since.toISOString()}
          AND coalesce(te.occurred_at, te.created_at) <= ${now.toISOString()}`;
      const [rows, summary] = await Promise.all([
        db.execute(sql`
          SELECT te.id, coalesce(te.activity_type, te.kind) AS kind, te.subject, te.body,
            te.owner_name AS "ownerName", coalesce(te.occurred_at, te.created_at) AS "occurredAt",
            coalesce(tc.title, torg.name) AS "clientName",
            CASE WHEN tc.id IS NOT NULL THEN 'pipelines/' || tc.pipeline_id || '/items/' || tc.id
              WHEN torg.id IS NOT NULL THEN 'organisations/' || torg.id
              ELSE 'organisations' END AS path
          ${inWindow}
          ORDER BY coalesce(te.occurred_at, te.created_at) DESC, te.id
          LIMIT ${options.limit}
        `) as unknown as Promise<ActivityRow[]>,
        db.execute(sql`
          SELECT coalesce(te.activity_type, te.kind) AS kind, count(*)::int AS count,
            count(DISTINCT coalesce(tc.id::text, torg.id::text)) FILTER (WHERE coalesce(tc.id, torg.id) IS NOT NULL)::int AS clients
          ${inWindow}
          GROUP BY ROLLUP (coalesce(te.activity_type, te.kind))
        `) as unknown as Promise<Array<{ kind: string | null; count: number; clients: number }>>,
      ]);
      const prefix = await routePrefix(db, companyId);
      const totalRow = summary.find((row) => row.kind === null);
      const byKind = summary
        .filter((row) => row.kind !== null)
        .map((row): [string, number] => [kindLabel(row.kind!), Number(row.count)])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const activity: CompanyClientActivity[] = rows.map((row) => ({
        id: row.id,
        kindLabel: kindLabel(row.kind),
        title: plainText(row.subject) || plainText(row.body) || kindLabel(row.kind),
        clientName: row.clientName,
        ownerName: row.ownerName,
        occurredAt: iso(row.occurredAt)!,
        href: `/${prefix}/${row.path}`,
      }));
      return {
        days: options.days,
        activity,
        total: Number(totalRow?.count ?? 0),
        clientCount: Number(totalRow?.clients ?? 0),
        byKind,
      };
    },
  };
}
