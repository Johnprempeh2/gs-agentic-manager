import { sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import type {
  CompanyClientActivity,
  CompanyClientBriefResponse,
  CompanyClosingDeal,
  CompanyClosingDealsResponse,
  CompanyPipelineDeal,
  CompanyPipelineStageSummary,
  CompanyPipelineSummaryResponse,
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

interface ClosingRow {
  row_kind: "deal" | "currency" | "overdue";
  caseId: string | null;
  title: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  stageName: string | null;
  organisationName: string | null;
  closeDate: string | null;
  value: number | string | null;
  currency: string | null;
  count: number | null;
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
      options: { days: number; limit: number; now?: Date; since?: Date },
    ): Promise<CompanyRecentClientActivityResponse> => {
      const now = options.now ?? new Date();
      const earliest = new Date(now.getTime() - 365 * DAY_MS);
      const since = options.since
        ? new Date(Math.max(options.since.getTime(), earliest.getTime()))
        : new Date(now.getTime() - options.days * DAY_MS);
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

    /**
     * A brief on the organisation that best matches `name`: exact name first,
     * then names starting with it, then names containing it.
     */
    clientBrief: async (companyId: string, name: string, options: { now?: Date } = {}): Promise<CompanyClientBriefResponse> => {
      const now = options.now ?? new Date();
      const needle = name.trim();
      if (!needle) return { brief: null };
      const escaped = needle.replace(/[\\%_]/g, (char) => `\\${char}`);
      const orgs = await db.execute(sql`
        SELECT o.id, o.name, o.status, o.industry, o.country
        FROM organisations o
        WHERE o.company_id = ${companyId} AND o.archived_at IS NULL
          AND o.name ILIKE ${`%${escaped}%`}
        ORDER BY CASE WHEN lower(o.name) = lower(${needle}) THEN 0
          WHEN o.name ILIKE ${`${escaped}%`} THEN 1 ELSE 2 END,
          length(o.name), o.updated_at DESC
        LIMIT 1
      `) as unknown as Array<{ id: string; name: string; status: string; industry: string | null; country: string | null }>;
      const org = orgs[0];
      if (!org) return { brief: null };
      const [people, deals, touches] = await Promise.all([
        db.execute(sql`
          SELECT c.name, c.role, c.email, count(*) OVER ()::int AS total
          FROM organisation_contacts c
          WHERE c.company_id = ${companyId} AND c.organisation_id = ${org.id} AND c.archived_at IS NULL
          ORDER BY c.is_key_contact DESC, c.updated_at DESC
          LIMIT 3
        `) as unknown as Promise<Array<{ name: string; role: string | null; email: string | null; total: number }>>,
        db.execute(sql`
          SELECT pc.id, pc.title, pc.pipeline_id AS "pipelineId", st.name AS "stageName", p.name AS "pipelineName"
          FROM pipeline_cases pc
          JOIN pipelines p ON p.id = pc.pipeline_id AND p.archived_at IS NULL
          JOIN pipeline_stages st ON st.id = pc.stage_id AND st.kind IN ('working', 'review')
          WHERE pc.company_id = ${companyId} AND pc.organisation_id = ${org.id}
            AND pc.retired_at IS NULL AND pc.terminal_at IS NULL AND pc.hidden_from_board_at IS NULL
          ORDER BY pc.created_at DESC
          LIMIT 5
        `) as unknown as Promise<Array<{ id: string; title: string; pipelineId: string; stageName: string; pipelineName: string }>>,
        db.execute(sql`
          SELECT coalesce(te.occurred_at, te.created_at) AS at, coalesce(te.activity_type, te.kind) AS kind,
            coalesce(nullif(te.subject, ''), te.body) AS subject
          FROM crm_timeline_entries te
          LEFT JOIN pipeline_cases tc ON tc.id = te.case_id
          WHERE te.company_id = ${companyId} AND te.kind <> 'stage_change'
            AND (te.organisation_id = ${org.id} OR tc.organisation_id = ${org.id})
          ORDER BY coalesce(te.occurred_at, te.created_at) DESC
          LIMIT 1
        `) as unknown as Promise<Array<{ at: Date | string; kind: string; subject: string | null }>>,
      ]);
      const prefix = await routePrefix(db, companyId);
      const touch = touches[0];
      const lastTouchAt = touch ? iso(touch.at)! : null;
      return {
        brief: {
          organisation: { ...org, href: `/${prefix}/organisations/${org.id}` },
          people: people.map(({ name: personName, role, email }) => ({ name: personName, role, email })),
          peopleCount: Number(people[0]?.total ?? 0),
          openDeals: deals.map((deal) => ({
            title: deal.title,
            stageName: deal.stageName,
            pipelineName: deal.pipelineName,
            href: `/${prefix}/pipelines/${deal.pipelineId}/items/${deal.id}`,
          })),
          lastTouch: touch && lastTouchAt ? { at: lastTouchAt, label: touchLabel(touch.kind, touch.subject) ?? "Contact" } : null,
          quietDays: lastTouchAt ? Math.max(0, Math.floor((now.getTime() - new Date(lastTouchAt).getTime()) / DAY_MS)) : null,
        },
      };
    },

    /**
     * Open deals and leads whose expected close date falls within `days`
     * (or has already passed), soonest first, with the window's value per
     * currency. Reads the imported `expectedCloseDate`, `dealValue` or
     * `leadValue` and currency fields.
     */
    closing: async (
      companyId: string,
      options: { days: number; limit: number; now?: Date },
    ): Promise<CompanyClosingDealsResponse> => {
      const now = options.now ?? new Date();
      const today = now.toISOString().slice(0, 10);
      const until = new Date(now.getTime() + options.days * DAY_MS).toISOString().slice(0, 10);
      const rows = await db.execute(sql`
        WITH dated AS (
          SELECT pc.id, pc.title, pc.pipeline_id, p.name AS pipeline_name, st.name AS stage_name,
            o.name AS organisation_name,
            pc.fields->>'expectedCloseDate' AS close_date,
            CASE
              WHEN jsonb_typeof(pc.fields->'dealValue') = 'number' THEN (pc.fields->>'dealValue')::numeric
              WHEN jsonb_typeof(pc.fields->'leadValue') = 'number' THEN (pc.fields->>'leadValue')::numeric
            END AS value,
            nullif(trim(coalesce(pc.fields->>'dealCurrency', pc.fields->>'leadCurrency')), '') AS currency
          FROM pipeline_cases pc
          JOIN pipelines p ON p.id = pc.pipeline_id AND p.archived_at IS NULL
          JOIN pipeline_stages st ON st.id = pc.stage_id AND st.kind IN ('working', 'review')
          LEFT JOIN organisations o ON o.id = pc.organisation_id AND o.archived_at IS NULL
          WHERE pc.company_id = ${companyId}
            AND pc.retired_at IS NULL
            AND pc.terminal_at IS NULL
            AND pc.hidden_from_board_at IS NULL
            AND pc.fields->>'expectedCloseDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ),
        windowed AS (
          SELECT * FROM dated WHERE close_date <= ${until}
        )
        SELECT 'deal' AS row_kind, id AS "caseId", title, pipeline_id AS "pipelineId", pipeline_name AS "pipelineName",
          stage_name AS "stageName", organisation_name AS "organisationName", close_date AS "closeDate",
          value::float8 AS value, currency, NULL::int AS count
        FROM (SELECT * FROM windowed ORDER BY close_date ASC, id LIMIT ${options.limit}) shown
        UNION ALL
        SELECT 'currency', NULL, NULL, NULL, NULL, NULL, NULL, NULL, coalesce(sum(value), 0)::float8, currency, count(*)::int
        FROM windowed GROUP BY currency
        UNION ALL
        SELECT 'overdue', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, count(*)::int
        FROM windowed WHERE close_date < ${today}
      `) as unknown as ClosingRow[];

      const prefix = await routePrefix(db, companyId);
      const dealRows = rows.filter((row) => row.row_kind === "deal");
      const currencyRows = rows.filter((row) => row.row_kind === "currency");
      const deals: CompanyClosingDeal[] = dealRows
        .sort((a, b) => (a.closeDate! < b.closeDate! ? -1 : a.closeDate! > b.closeDate! ? 1 : 0))
        .map((row) => ({
          caseId: row.caseId!,
          title: row.title!,
          pipelineName: row.pipelineName!,
          stageName: row.stageName!,
          organisationName: row.organisationName,
          expectedCloseDate: row.closeDate!,
          overdue: row.closeDate! < today,
          value: row.value === null ? null : Number(row.value),
          currency: row.currency,
          href: `/${prefix}/pipelines/${row.pipelineId}/items/${row.caseId}`,
        }));
      return {
        days: options.days,
        deals,
        total: currencyRows.reduce((sum, row) => sum + Number(row.count ?? 0), 0),
        overdueCount: Number(rows.find((row) => row.row_kind === "overdue")?.count ?? 0),
        valueByCurrency: currencyRows
          .map((row) => ({ currency: row.currency, value: Number(row.value ?? 0), count: Number(row.count ?? 0) }))
          .sort((a, b) => b.value - a.value),
      };
    },

    /**
     * Open deals and leads across pipelines: count and value per stage, the
     * overall value per currency, and the largest deals by value.
     */
    pipelineSummary: async (companyId: string, options: { limit: number }): Promise<CompanyPipelineSummaryResponse> => {
      const open = sql`
        SELECT pc.id, pc.title, pc.pipeline_id, p.name AS pipeline_name, st.name AS stage_name, st.position AS stage_position,
          o.name AS organisation_name,
          CASE WHEN pc.fields->>'expectedCloseDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN pc.fields->>'expectedCloseDate' END AS close_date,
          CASE
            WHEN jsonb_typeof(pc.fields->'dealValue') = 'number' THEN (pc.fields->>'dealValue')::numeric
            WHEN jsonb_typeof(pc.fields->'leadValue') = 'number' THEN (pc.fields->>'leadValue')::numeric
          END AS value,
          nullif(trim(coalesce(pc.fields->>'dealCurrency', pc.fields->>'leadCurrency')), '') AS currency
        FROM pipeline_cases pc
        JOIN pipelines p ON p.id = pc.pipeline_id AND p.archived_at IS NULL
        JOIN pipeline_stages st ON st.id = pc.stage_id AND st.kind IN ('working', 'review')
        LEFT JOIN organisations o ON o.id = pc.organisation_id AND o.archived_at IS NULL
        WHERE pc.company_id = ${companyId}
          AND pc.retired_at IS NULL
          AND pc.terminal_at IS NULL
          AND pc.hidden_from_board_at IS NULL
      `;
      const stageRows = await db.execute(sql`
        WITH open_cases AS (${open})
        SELECT pipeline_id AS "pipelineId", pipeline_name AS "pipelineName", stage_name AS "stageName",
          min(stage_position) AS position, currency, count(*)::int AS count, coalesce(sum(value), 0)::float8 AS value
        FROM open_cases
        GROUP BY pipeline_id, pipeline_name, stage_name, currency
        ORDER BY pipeline_name, pipeline_id, min(stage_position), stage_name
      `) as unknown as Array<{ pipelineId: string; pipelineName: string; stageName: string; position: number; currency: string | null; count: number; value: number }>;
      const topRows = await db.execute(sql`
        WITH open_cases AS (${open})
        SELECT id AS "caseId", title, pipeline_id AS "pipelineId", pipeline_name AS "pipelineName", stage_name AS "stageName",
          organisation_name AS "organisationName", value::float8 AS value, currency, close_date AS "closeDate"
        FROM open_cases
        WHERE value > 0
        ORDER BY value DESC, id
        LIMIT ${options.limit}
      `) as unknown as Array<{ caseId: string; title: string; pipelineId: string; pipelineName: string; stageName: string; organisationName: string | null; value: number; currency: string | null; closeDate: string | null }>;

      const stages: CompanyPipelineStageSummary[] = [];
      const totals = new Map<string | null, { value: number; count: number }>();
      for (const row of stageRows) {
        let stage = stages.find((entry) => entry.pipelineId === row.pipelineId && entry.stageName === row.stageName);
        if (!stage) {
          stage = { pipelineId: row.pipelineId, pipelineName: row.pipelineName, stageName: row.stageName, count: 0, valueByCurrency: [] };
          stages.push(stage);
        }
        stage.count += Number(row.count);
        if (Number(row.value) > 0) stage.valueByCurrency.push({ currency: row.currency, value: Number(row.value) });
        const total = totals.get(row.currency) ?? { value: 0, count: 0 };
        total.value += Number(row.value);
        total.count += Number(row.count);
        totals.set(row.currency, total);
      }
      const prefix = await routePrefix(db, companyId);
      const topDeals: CompanyPipelineDeal[] = topRows.map((row) => ({
        caseId: row.caseId,
        title: row.title,
        pipelineName: row.pipelineName,
        stageName: row.stageName,
        organisationName: row.organisationName,
        value: Number(row.value),
        currency: row.currency,
        expectedCloseDate: row.closeDate,
        href: `/${prefix}/pipelines/${row.pipelineId}/items/${row.caseId}`,
      }));
      return {
        total: stages.reduce((sum, stage) => sum + stage.count, 0),
        valueByCurrency: [...totals.entries()]
          .map(([currency, total]) => ({ currency, value: total.value, count: total.count }))
          .sort((a, b) => b.value - a.value),
        stages,
        topDeals,
      };
    },
  };
}
