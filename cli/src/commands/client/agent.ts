import { Command } from "commander";
import {
  agentSkillSyncSchema,
  createAgentSchema,
  resetAgentSessionSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentInstructionsPathSchema,
  updateAgentPermissionsSchema,
  updateAgentSchema,
  upsertAgentInstructionsFileSchema,
  wakeAgentSchema,
  type Agent,
  type AgentWakeupResponse,
  type Issue,
} from "@greatstone/shared";
import {
  removeMaintainerOnlySkillSymlinks,
  resolvePaperclipSkillsDir,
} from "@greatstone/adapter-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AgentListOptions extends BaseClientOptions {
  companyId?: string;
}

interface AgentLocalCliOptions extends BaseClientOptions {
  companyId?: string;
  keyName?: string;
  installSkills?: boolean;
}

interface AgentDoneOptions extends BaseClientOptions {
  limit?: string;
}

interface AgentFindOptions extends BaseClientOptions {
  companyId?: string;
  limit?: string;
}

interface DirectoryMatch {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  status: string;
  capabilities: string | null;
  matched: string[];
}

interface AgentInboxMineOptions extends BaseClientOptions {
  userId: string;
  status?: string;
}

interface AgentWakeOptions extends BaseClientOptions {
  companyId?: string;
  source?: string;
  trigger?: string;
  reason?: string;
  payload?: string;
  idempotencyKey?: string;
  forceFreshSession?: boolean;
}

interface AgentJsonPayloadOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson: string;
}

interface AgentDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface AgentResetSessionOptions extends BaseClientOptions {
  taskKey?: string;
}

interface AgentSkillsSyncOptions extends BaseClientOptions {
  desiredSkills: string;
  mode: string;
}

interface AgentInstructionsFileOptions extends BaseClientOptions {
  path: string;
}

interface AgentInstructionsFilePutOptions extends BaseClientOptions {
  path: string;
  content?: string;
  contentFile?: string;
  clearLegacyPromptTemplate?: boolean;
}

interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

interface SkillsInstallSummary {
  tool: "codex" | "claude" | "kimi";
  target: string;
  linked: string[];
  removed: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function codexSkillsHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".codex");
  return path.join(base, "skills");
}

function claudeSkillsHome(): string {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".claude");
  return path.join(base, "skills");
}

function kimiSkillsHome(): string {
  const fromEnv = process.env.KIMI_CODE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".kimi-code");
  return path.join(base, "skills");
}

async function installSkillsForTarget(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  tool: "codex" | "claude" | "kimi",
): Promise<SkillsInstallSummary> {
  const summary: SkillsInstallSummary = {
    tool,
    target: targetSkillsDir,
    linked: [],
    removed: [],
    skipped: [],
    failed: [],
  };

  await fs.mkdir(targetSkillsDir, { recursive: true });
  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });
  summary.removed = await removeMaintainerOnlySkillSymlinks(
    targetSkillsDir,
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceSkillsDir, entry.name);
    const target = path.join(targetSkillsDir, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink()) {
        let linkedPath: string | null = null;
        try {
          linkedPath = await fs.readlink(target);
        } catch (err) {
          await fs.unlink(target);
          try {
            await fs.symlink(source, target);
            summary.linked.push(entry.name);
            continue;
          } catch (linkErr) {
            summary.failed.push({
              name: entry.name,
              error:
                err instanceof Error && linkErr instanceof Error
                  ? `${err.message}; then ${linkErr.message}`
                  : err instanceof Error
                    ? err.message
                    : `Failed to recover broken symlink: ${String(err)}`,
            });
            continue;
          }
        }

        const resolvedLinkedPath = path.isAbsolute(linkedPath)
          ? linkedPath
          : path.resolve(path.dirname(target), linkedPath);
        const linkedTargetExists = await fs
          .stat(resolvedLinkedPath)
          .then(() => true)
          .catch(() => false);

        if (!linkedTargetExists) {
          await fs.unlink(target);
        } else {
          summary.skipped.push(entry.name);
          continue;
        }
      } else {
        summary.skipped.push(entry.name);
        continue;
      }
    }

    try {
      await fs.symlink(source, target);
      summary.linked.push(entry.name);
    } catch (err) {
      summary.failed.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function buildAgentEnvExports(input: {
  apiBase: string;
  companyId: string;
  agentId: string;
  apiKey: string;
}): string {
  const escaped = (value: string) => value.replace(/'/g, "'\"'\"'");
  return [
    `export GSAM_API_URL='${escaped(input.apiBase)}'`,
    `export GSAM_COMPANY_ID='${escaped(input.companyId)}'`,
    `export GSAM_AGENT_ID='${escaped(input.agentId)}'`,
    `export GSAM_API_KEY='${escaped(input.apiKey)}'`,
  ].join("\n");
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent operations");

  addCommonClientOptions(
    agent
      .command("me")
      .description("Show the current agent identity")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const me = await ctx.api.get<Agent>("/api/agents/me");
          printOutput(me, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("inbox")
      .description("List current agent assigned inbox items")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<Issue[]>("/api/agents/me/inbox-lite")) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              identifier: row.identifier,
              id: row.id,
              status: row.status,
              priority: row.priority,
              title: row.title,
              projectId: row.projectId,
            }));
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("done")
      .description("List the current agent's recently finished tasks, newest first")
      .option("--limit <n>", "How many to show (1 to 50)", "10")
      .action(async (opts: AgentDoneOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams({ limit: opts.limit ?? "10" });
          const rows =
            (await ctx.api.get<Array<{ id: string; identifier: string | null; title: string; completedAt: string | null }>>(
              `/api/agents/me/recent-done?${params.toString()}`,
            )) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({ identifier: row.identifier, id: row.id, completedAt: row.completedAt, title: row.title }));
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("budget")
      .description("Show the current agent's spend this month against its monthly budget")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const me = await ctx.api.get<Agent>("/api/agents/me");
          const summary = agentBudgetSummary(me?.budgetMonthlyCents ?? 0, me?.spentMonthlyCents ?? 0);
          if (ctx.json) {
            printOutput(summary, { json: true });
            return;
          }
          console.log(summary.text);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("approvals")
      .description("List approval requests the current agent filed that are still open, oldest first")
      .option("--all", "Include approved, rejected and cancelled requests")
      .action(async (opts: BaseClientOptions & { all?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows =
            (await ctx.api.get<Array<{ id: string; type: string; status: string; decisionNote: string | null; ageDays: number }>>(
              `/api/agents/me/approvals${opts.all ? "?all=true" : ""}`,
            )) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(
              formatInlineRecord({ id: row.id, type: row.type, status: row.status, ageDays: row.ageDays, note: row.decisionNote }),
            );
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("waiting")
      .description("List the current agent's tasks that other open tasks are waiting on, biggest chain first")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows =
            (await ctx.api.get<Array<{
              issue: { id: string; identifier: string | null; title: string; status: string };
              action: string | null;
              waitingCount: number;
            }>>("/api/agents/me/waiting-on-me")) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(
              formatInlineRecord({
                identifier: row.issue.identifier,
                id: row.issue.id,
                status: row.issue.status,
                waiting: row.waitingCount,
                title: row.issue.title,
              }),
            );
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("today")
      .description("One summary of what needs the current agent now: overdue and due tasks, blocked work, what others wait on, open approvals, failed runs and budget")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const [me, inbox, waiting, approvals, failures] = await Promise.all([
            ctx.api.get<Agent>("/api/agents/me"),
            ctx.api.get<AgentTodayInboxRow[]>("/api/agents/me/inbox-lite"),
            ctx.api.get<AgentTodayWaitingRow[]>("/api/agents/me/waiting-on-me"),
            ctx.api.get<Array<{ id: string }>>("/api/agents/me/approvals"),
            ctx.api.get<Array<{ id: string }>>("/api/agents/me/failed-runs?limit=5"),
          ]);
          const digest = agentTodayDigest({
            inbox: inbox ?? [],
            waiting: waiting ?? [],
            openApprovals: approvals?.length ?? 0,
            recentFailures: failures?.length ?? 0,
            budgetMonthlyCents: me?.budgetMonthlyCents ?? 0,
            spentMonthlyCents: me?.spentMonthlyCents ?? 0,
            today: new Date().toISOString().slice(0, 10),
          });
          if (ctx.json) {
            printOutput(digest, { json: true });
            return;
          }
          for (const line of digest.lines) console.log(line);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("failures")
      .description("Show the current agent's last failed runs and their errors")
      .option("--limit <n>", "How many to show (1 to 20)", "5")
      .action(async (opts: AgentDoneOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams({ limit: opts.limit ?? "5" });
          const rows =
            (await ctx.api.get<Array<{ id: string; status: string; createdAt: string; errorCode: string | null; error: string | null }>>(
              `/api/agents/me/failed-runs?${params.toString()}`,
            )) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(
              formatInlineRecord({ id: row.id, status: row.status, createdAt: row.createdAt, errorCode: row.errorCode, error: row.error }),
            );
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("find")
      .description("Find colleagues who can help, ranked by their capabilities, title and role")
      .argument("<query>", "What you need help with, such as \"seo audit\"")
      .option("-C, --company-id <id>", "Company ID")
      .option("--limit <n>", "How many to show (1 to 50)", "10")
      .action(async (query: string, opts: AgentFindOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams({ q: query, limit: opts.limit ?? "10" });
          const result = await ctx.api.get<{ query: string; agents: DirectoryMatch[] }>(
            `${apiPath`/api/companies/${ctx.companyId}/agents/directory`}?${params.toString()}`,
          );
          const rows = result?.agents ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({ name: row.name, id: row.id, title: row.title, status: row.status, matched: row.matched.join(" ") }));
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("inbox-mine")
      .description("List current agent inbox items touched or archived by a board user")
      .requiredOption("--user-id <id>", "Board user ID")
      .option("--status <csv>", "Comma-separated issue statuses")
      .action(async (opts: AgentInboxMineOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams({ userId: opts.userId });
          if (opts.status) params.set("status", opts.status);
          const rows = (await ctx.api.get<Issue[]>(`/api/agents/me/inbox/mine?${params.toString()}`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("list")
      .description("List agents for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Agent[]>(apiPath`/api/companies/${ctx.companyId}/agents`)) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                name: row.name,
                role: row.role,
                status: row.status,
                reportsTo: row.reportsTo,
                budgetMonthlyCents: row.budgetMonthlyCents,
                spentMonthlyCents: row.spentMonthlyCents,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("get")
      .description("Get one agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Agent>(apiPath`/api/agents/${agentId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("create")
      .description("Create an agent from a JSON payload")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "CreateAgent JSON payload")
      .action(async (opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createAgentSchema.parse(parseJson(opts.payloadJson));
          const created = await ctx.api.post<Agent>(apiPath`/api/companies/${ctx.companyId}/agents`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("hire")
      .description("Create an agent hire request")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "CreateAgentHire JSON payload")
      .action(async (opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/agent-hires`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("update")
      .description("Update an agent from a JSON payload")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgent JSON payload")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentSchema.parse(parseJson(opts.payloadJson));
          const updated = await ctx.api.patch<Agent>(apiPath`/api/agents/${agentId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("delete")
      .description("Delete an agent")
      .argument("<agentId>", "Agent ID")
      .option("--yes", "Confirm deletion")
      .action(async (agentId: string, opts: AgentDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Refusing to delete without --yes");
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/agents/${agentId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, path, description] of [
    ["pause", "pause", "Pause an agent"],
    ["resume", "resume", "Resume an agent"],
    ["approve", "approve", "Approve a pending agent"],
    ["terminate", "terminate", "Terminate an agent"],
    ["heartbeat:invoke", "heartbeat/invoke", "Invoke an agent heartbeat"],
    ["claude-login", "claude-login", "Trigger Claude login for an agent"],
    ["clear-error", "clear-error", "Clear an agent's error state"],
  ] as const) {
    addCommonClientOptions(
      agent
        .command(name)
        .description(description)
        .argument("<agentId>", "Agent ID")
        .action(async (agentId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const result = await ctx.api.post(`${apiPath`/api/agents/${agentId}`}/${path}`, {});
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    agent
      .command("permissions:update")
      .description("Update agent permissions")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgentPermissions JSON payload")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentPermissionsSchema.parse(parseJson(opts.payloadJson));
          const updated = await ctx.api.patch(apiPath`/api/agents/${agentId}/permissions`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("configuration")
      .description("Get redacted agent configuration")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/configuration`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revisions")
      .description("List agent config revisions")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/config-revisions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revision:get")
      .description("Get one agent config revision")
      .argument("<agentId>", "Agent ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/config-revisions/${revisionId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revision:rollback")
      .description("Roll an agent back to a config revision")
      .argument("<agentId>", "Agent ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`, {});
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime-state")
      .description("Get agent runtime state")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/runtime-state`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime-state:reset-session")
      .description("Reset an agent runtime session")
      .argument("<agentId>", "Agent ID")
      .option("--task-key <key>", "Specific task session key")
      .action(async (agentId: string, opts: AgentResetSessionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resetAgentSessionSchema.parse({ taskKey: opts.taskKey });
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/runtime-state/reset-session`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("task-sessions")
      .description("List agent task sessions")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/task-sessions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("skills")
      .description("List agent skills")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/skills`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("skills:sync")
      .description("Sync desired skills onto an agent")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--desired-skills <csv>", "Desired skill names")
      .requiredOption(
        "--mode <mode>",
        "Merge mode: add keeps other skills; remove deletes only named skills; replace destructively overwrites the complete set",
      )
      .action(async (agentId: string, opts: AgentSkillsSyncOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = agentSkillSyncSchema.parse({
            desiredSkills: parseCsv(opts.desiredSkills),
            mode: opts.mode,
          });
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/skills/sync`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-path:update")
      .description("Update an agent instructions path. Process adapters require adapterConfigKey and relative paths require adapterConfig.cwd.")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgentInstructionsPath JSON payload, for example {\"path\":\"/tmp/AGENTS.md\",\"adapterConfigKey\":\"instructionsFilePath\"}")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentInstructionsPathSchema.parse(parseJson(opts.payloadJson));
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/instructions-path`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-bundle")
      .description("Get an agent instructions bundle")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/instructions-bundle`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-bundle:update")
      .description("Update an agent instructions bundle")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgentInstructionsBundle JSON payload")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentInstructionsBundleSchema.parse(parseJson(opts.payloadJson));
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/instructions-bundle`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:get")
      .description("Get an agent instructions file")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <path>", "Bundle-relative file path")
      .action(async (agentId: string, opts: AgentInstructionsFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams({ path: opts.path });
          const result = await ctx.api.get(`${apiPath`/api/agents/${agentId}/instructions-bundle/file`}?${query.toString()}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:put")
      .description("Create or update an agent instructions file")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <path>", "Bundle-relative file path")
      .option("--content <text>", "File content")
      .option("--content-file <path>", "Read file content from disk")
      .option("--clear-legacy-prompt-template", "Clear legacy prompt template")
      .action(async (agentId: string, opts: AgentInstructionsFilePutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const content = opts.contentFile ? await fs.readFile(opts.contentFile, "utf8") : opts.content;
          const payload = upsertAgentInstructionsFileSchema.parse({
            path: opts.path,
            content,
            clearLegacyPromptTemplate: Boolean(opts.clearLegacyPromptTemplate),
          });
          const result = await ctx.api.put(apiPath`/api/agents/${agentId}/instructions-bundle/file`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:delete")
      .description("Delete an agent instructions file")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <path>", "Bundle-relative file path")
      .action(async (agentId: string, opts: AgentInstructionsFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams({ path: opts.path });
          const result = await ctx.api.delete(`${apiPath`/api/agents/${agentId}/instructions-bundle/file`}?${query.toString()}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("wake")
      .description("Request a heartbeat wakeup for an agent")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .option("-C, --company-id <id>", "Company ID for shortname/url-key lookup")
      .option("--source <source>", "Invocation source (timer, assignment, on_demand, automation)", "on_demand")
      .option("--trigger <trigger>", "Trigger detail (manual, ping, callback, system)", "manual")
      .option("--reason <text>", "Wakeup reason")
      .option("--payload <json>", "JSON object payload")
      .option("--idempotency-key <key>", "Wakeup idempotency key")
      .option("--force-fresh-session", "Request a fresh adapter session")
      .action(async (agentRef: string, opts: AgentWakeOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.companyId ? `?${new URLSearchParams({ companyId: opts.companyId }).toString()}` : "";
          const agentRow = await ctx.api.get<Agent>(`${apiPath`/api/agents/${agentRef}`}${query}`);
          if (!agentRow) {
            throw new Error(`Agent not found: ${agentRef}`);
          }
          const payload = wakeAgentSchema.parse({
            source: opts.source,
            triggerDetail: opts.trigger,
            reason: opts.reason,
            payload: parseJsonObject(opts.payload),
            idempotencyKey: opts.idempotencyKey,
            forceFreshSession: Boolean(opts.forceFreshSession),
          });
          const result = await ctx.api.post<AgentWakeupResponse>(apiPath`/api/agents/${agentRow.id}/wakeup`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("local-cli")
      .description(
        "Create an agent API key, install local GS Agentic Manager skills for Codex/Claude, and print shell exports",
      )
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--key-name <name>", "API key label", "local-cli")
      .option(
        "--no-install-skills",
        "Skip installing GS Agentic Manager skills into ~/.codex/skills, ~/.claude/skills, and ~/.kimi-code/skills",
      )
      .action(async (agentRef: string, opts: AgentLocalCliOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ companyId: ctx.companyId ?? "" });
          const agentRow = await ctx.api.get<Agent>(
            `${apiPath`/api/agents/${agentRef}`}?${query.toString()}`,
          );
          if (!agentRow) {
            throw new Error(`Agent not found: ${agentRef}`);
          }

          const now = new Date().toISOString().replaceAll(":", "-");
          const keyName = opts.keyName?.trim() ? opts.keyName.trim() : `local-cli-${now}`;
          const key = await ctx.api.post<CreatedAgentKey>(apiPath`/api/agents/${agentRow.id}/keys`, { name: keyName });
          if (!key) {
            throw new Error("Failed to create API key");
          }

          const installSummaries: SkillsInstallSummary[] = [];
          if (opts.installSkills !== false) {
            const skillsDir = await resolvePaperclipSkillsDir(__moduleDir, [path.resolve(process.cwd(), "skills")]);
            if (!skillsDir) {
              throw new Error(
                "Could not locate local GS Agentic Manager skills directory. Expected ./skills in the repo checkout.",
              );
            }

            installSummaries.push(
              await installSkillsForTarget(skillsDir, codexSkillsHome(), "codex"),
              await installSkillsForTarget(skillsDir, claudeSkillsHome(), "claude"),
              await installSkillsForTarget(skillsDir, kimiSkillsHome(), "kimi"),
            );
          }

          const exportsText = buildAgentEnvExports({
            apiBase: ctx.api.apiBase,
            companyId: agentRow.companyId,
            agentId: agentRow.id,
            apiKey: key.token,
          });

          if (ctx.json) {
            printOutput(
              {
                agent: {
                  id: agentRow.id,
                  name: agentRow.name,
                  urlKey: agentRow.urlKey,
                  companyId: agentRow.companyId,
                },
                key: {
                  id: key.id,
                  name: key.name,
                  createdAt: key.createdAt,
                  token: key.token,
                },
                skills: installSummaries,
                exports: exportsText,
              },
              { json: true },
            );
            return;
          }

          console.log(`Agent: ${agentRow.name} (${agentRow.id})`);
          console.log(`API key created: ${key.name} (${key.id})`);
          if (installSummaries.length > 0) {
            for (const summary of installSummaries) {
              console.log(
                `${summary.tool}: linked=${summary.linked.length} removed=${summary.removed.length} skipped=${summary.skipped.length} failed=${summary.failed.length} target=${summary.target}`,
              );
              for (const failed of summary.failed) {
                console.log(`  failed ${failed.name}: ${failed.error}`);
              }
            }
          }
          console.log("");
          console.log("# Run this in your shell before launching codex/claude:");
          console.log(exportsText);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "Spent $12.40 of $50.00 this month (25%)"; a budget of 0 means no cap is set. */
export interface AgentTodayInboxRow {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  dueDate?: string | null;
}

export interface AgentTodayWaitingRow {
  issue: { id: string; identifier: string | null; title: string };
  waitingCount: number;
}

function taskLabel(row: { identifier: string | null; title: string }) {
  return row.identifier ? `${row.identifier} ${row.title}` : row.title;
}

// Builds the "what needs me now" summary from the agent's own endpoints, most
// pressing first, so an agent can plan a heartbeat from one call.
export function agentTodayDigest(input: {
  inbox: AgentTodayInboxRow[];
  waiting: AgentTodayWaitingRow[];
  openApprovals: number;
  recentFailures: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  today: string;
}) {
  const open = input.inbox.filter((row) => row.status !== "done" && row.status !== "cancelled");
  const overdue = open
    .filter((row) => row.dueDate && row.dueDate < input.today)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  const dueToday = open.filter((row) => row.dueDate === input.today);
  const blocked = open.filter((row) => row.status === "blocked");
  const inProgress = open.filter((row) => row.status === "in_progress");
  const todo = open.filter((row) => row.status === "todo");
  const waiting = [...input.waiting].sort((a, b) => b.waitingCount - a.waitingCount);
  const budget = agentBudgetSummary(input.budgetMonthlyCents, input.spentMonthlyCents);

  const lines: string[] = [];
  lines.push(`Open tasks: ${inProgress.length} in progress, ${todo.length} to do, ${blocked.length} blocked.`);
  for (const row of overdue) lines.push(`Overdue since ${row.dueDate}: ${taskLabel(row)}`);
  for (const row of dueToday) lines.push(`Due today: ${taskLabel(row)}`);
  for (const row of waiting.slice(0, 5)) {
    lines.push(`${row.waitingCount} ${row.waitingCount === 1 ? "task waits" : "tasks wait"} on: ${taskLabel(row.issue)}`);
  }
  for (const row of blocked) lines.push(`Blocked: ${taskLabel(row)}`);
  if (input.openApprovals > 0) {
    lines.push(`${input.openApprovals} approval ${input.openApprovals === 1 ? "request is" : "requests are"} still open (gsam agent approvals).`);
  }
  if (input.recentFailures > 0) {
    lines.push(`${input.recentFailures} recent failed ${input.recentFailures === 1 ? "run" : "runs"}; read them before retrying (gsam agent failures).`);
  }
  lines.push(budget.text);
  if (open.length === 0) lines.push("Nothing is assigned to you right now.");

  return {
    counts: {
      inProgress: inProgress.length,
      todo: todo.length,
      blocked: blocked.length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      waitedOn: waiting.length,
      openApprovals: input.openApprovals,
      recentFailures: input.recentFailures,
    },
    overdue: overdue.map((row) => ({ id: row.id, identifier: row.identifier, title: row.title, dueDate: row.dueDate })),
    dueToday: dueToday.map((row) => ({ id: row.id, identifier: row.identifier, title: row.title })),
    budget,
    lines,
  };
}

export function agentBudgetSummary(budgetMonthlyCents: number, spentMonthlyCents: number) {
  const budget = Math.max(0, budgetMonthlyCents);
  const spent = Math.max(0, spentMonthlyCents);
  if (budget === 0) {
    return { budgetMonthlyCents: 0, spentMonthlyCents: spent, remainingCents: null, percentUsed: null, text: `Spent ${formatDollars(spent)} this month. No monthly budget is set.` };
  }
  const remaining = Math.max(0, budget - spent);
  const percent = Math.round((spent / budget) * 100);
  return {
    budgetMonthlyCents: budget,
    spentMonthlyCents: spent,
    remainingCents: remaining,
    percentUsed: percent,
    text: `Spent ${formatDollars(spent)} of ${formatDollars(budget)} this month (${percent}%). ${formatDollars(remaining)} left.`,
  };
}
