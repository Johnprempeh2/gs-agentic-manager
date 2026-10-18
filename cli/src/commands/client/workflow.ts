import { Command } from "commander";
import { startWorkflowTemplateSchema } from "@greatstone/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface WorkflowTemplateRow {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  definition?: { steps?: unknown[] } | null;
  archivedAt?: string | null;
}

interface WorkflowStartOptions extends BaseClientOptions {
  title: string;
  description?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
}

export function registerWorkflowCommands(program: Command): void {
  const workflow = program.command("workflow").description("Saved workflows: ready-made multi-step plans");

  addCommonClientOptions(
    workflow
      .command("list")
      .description("List the company's saved workflows")
      .option("-C, --company-id <id>", "Company ID")
      .option("--include-archived", "Also list archived workflows")
      .action(async (opts: BaseClientOptions & { companyId?: string; includeArchived?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<WorkflowTemplateRow[]>(
              `${apiPath`/api/companies/${ctx.companyId}/workflow-templates`}${opts.includeArchived ? "?includeArchived=true" : ""}`,
            )) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(
              formatInlineRecord({
                key: row.key,
                id: row.id,
                steps: row.definition?.steps?.length ?? 0,
                name: row.name,
              }),
            );
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    workflow
      .command("start")
      .description("Start a saved workflow: creates the lead task and one task per step")
      .argument("<templateId>", "Workflow ID")
      .requiredOption("--title <title>", "Title for this run, such as \"Launch for Acme\"")
      .option("--description <text>", "What this run is for")
      .option("--project-id <id>", "Project for the new tasks")
      .option("--goal-id <id>", "Goal the new tasks serve")
      .option("--parent-id <id>", "Task the new tasks sit under")
      .action(async (templateId: string, opts: WorkflowStartOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = startWorkflowTemplateSchema.parse({
            title: opts.title,
            description: opts.description,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
          });
          const started = await ctx.api.post(apiPath`/api/workflow-templates/${templateId}/start`, payload);
          printOutput(started, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
