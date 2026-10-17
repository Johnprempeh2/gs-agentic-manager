import { useState } from "react";
import { Download, FileSpreadsheet } from "lucide-react";
import type { OrganisationListItem } from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { organisationsApi } from "@/api/organisations";
import { projectsApi } from "@/api/projects";
import { weeklyReportApi } from "@/api/weeklyReport";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { downloadTextFile } from "@/lib/issues-csv";
import {
  TASK_STATUS_LABELS,
  clientsSheet,
  downloadBytes,
  exportFileName,
  localToday,
  pipelineSheet,
  sheetToCsv,
  sheetsToXlsx,
  tasksSheet,
  weeklyNumbersSheet,
  type PipelineSheetCase,
  type PipelineSheetLookups,
  type Sheet,
} from "@/lib/spreadsheet-export";

type Format = "csv" | "xlsx";
export type ExportKind = "clients" | "tasks" | "week";

const KINDS: Array<{ kind: ExportKind; label: string; what: string; file: string }> = [
  { kind: "clients", label: "Clients", what: "Every organisation with its stage, key contacts and notes.", file: "clients" },
  { kind: "tasks", label: "Tasks", what: "Every task with its status, who holds it, due date and a link.", file: "tasks" },
  { kind: "week", label: "This week numbers", what: "The totals from This week: finished, stuck, pipeline moves and spend.", file: "this-week" },
];

/** Builds one sheet from the API. Only runs when someone asks for a download. */
export async function loadSheet(companyId: string, kind: ExportKind, prefix: string): Promise<Sheet> {
  if (kind === "clients") return clientsSheet(await organisationsApi.list(companyId, {}));
  if (kind === "week") return weeklyNumbersSheet(await weeklyReportApi.get(companyId));
  const [issues, agents, projects, directory] = await Promise.all([
    issuesApi.listAll(companyId, {}),
    agentsApi.list(companyId).catch(() => []),
    projectsApi.list(companyId, { includeArchived: true }).catch(() => []),
    accessApi.listUserDirectory(companyId).catch(() => null),
  ]);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const people = buildCompanyUserLabelMap(directory?.users);
  return tasksSheet(issues, {
    statusLabel: (status) => TASK_STATUS_LABELS[status] ?? status,
    agentName: (id) => agentNames.get(id),
    userLabel: (id) => people.get(id),
    projectName: (id) => projectNames.get(id),
    taskUrl: (issue) => `${window.location.origin}/${prefix}/issues/${issue.identifier ?? issue.id}`,
  });
}

function save(sheets: Sheet[], format: Format, prefix: string, file: string) {
  const name = exportFileName(prefix, file, localToday(), format);
  if (format === "csv") downloadTextFile(name, sheetToCsv(sheets[0]!));
  else downloadBytes(name, sheetsToXlsx(sheets));
}

/**
 * "Download to a spreadsheet" on Settings > Integrations: clients, tasks and
 * the This week numbers as CSV or Excel, so anything can go into a
 * spreadsheet without an API or a key.
 */
export function DataExportPanel({ companyId }: { companyId: string }) {
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, kinds: ExportKind[], format: Format, file: string) {
    setBusy(key);
    setError(null);
    try {
      const sheets = await Promise.all(kinds.map((kind) => loadSheet(companyId, kind, prefix)));
      save(sheets, format, prefix, file);
    } catch (err) {
      setError(`Could not build the download. ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3 pt-2" aria-labelledby="data-export-heading">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          <h2 id="data-export-heading" className="text-sm font-semibold">Download to a spreadsheet</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Take your clients, tasks or this week's numbers into Excel or Google Sheets. No account or key needed: the file
          is made from what you can see here.
        </p>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card" aria-label="Spreadsheet downloads">
        {KINDS.map((item) => (
          <li key={item.kind} className="flex flex-wrap items-center justify-between gap-3 p-3" data-testid={`export-${item.kind}`}>
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">{item.label}</p>
              <p className="text-xs text-muted-foreground">{item.what}</p>
            </div>
            <div className="flex gap-2">
              {(["csv", "xlsx"] as const).map((format) => {
                const key = `${item.kind}-${format}`;
                return (
                  <Button
                    key={format}
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void run(key, [item.kind], format, item.file)}
                    aria-label={`Download ${item.label.toLowerCase()} as ${format === "csv" ? "CSV" : "Excel"}`}
                  >
                    <Download />
                    {busy === key ? "Preparing…" : format === "csv" ? "CSV" : "Excel"}
                  </Button>
                );
              })}
            </div>
          </li>
        ))}
        <li className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">Everything</p>
            <p className="text-xs text-muted-foreground">One Excel file with a tab for each of the above.</p>
          </div>
          <Button size="sm" disabled={busy !== null} onClick={() => void run("all", ["clients", "tasks", "week"], "xlsx", "export")}>
            <Download />
            {busy === "all" ? "Preparing…" : "Excel workbook"}
          </Button>
        </li>
      </ul>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    </section>
  );
}

/** "Export" on the Organisations list: the organisations shown, as CSV or Excel. */
export function ClientsExportButton({ rows }: { rows: readonly OrganisationListItem[] }) {
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={rows.length === 0}>
          <Download />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => save([clientsSheet(rows)], "csv", prefix, "clients")}>CSV for any spreadsheet</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => save([clientsSheet(rows)], "xlsx", prefix, "clients")}>Excel workbook</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Export" on a pipeline board: the cards the board shows, with their deal fields, as CSV or Excel. */
export function PipelineExportButton({
  name,
  pipelineId,
  cases,
  stageName,
}: {
  name: string;
  pipelineId: string;
  cases: readonly PipelineSheetCase[];
  stageName: PipelineSheetLookups["stageName"];
}) {
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";
  const file = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pipeline";
  const build = () => [
    pipelineSheet(name, cases, {
      stageName,
      caseUrl: (item) => `${window.location.origin}/${prefix}/pipelines/${pipelineId}/cases/${item.id}`,
    }),
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={cases.length === 0} title="Download this board to a spreadsheet">
          <Download />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => save(build(), "csv", prefix, file)}>CSV for any spreadsheet</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => save(build(), "xlsx", prefix, file)}>Excel workbook</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
