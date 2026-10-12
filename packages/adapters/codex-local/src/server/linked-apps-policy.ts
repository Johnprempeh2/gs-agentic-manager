import { parseObject } from "@greatstone/adapter-utils/server-utils";

/**
 * Managed-run policy for the apps a user linked in ChatGPT (Gmail, Drive,
 * Calendar, Slack, ...), which Codex exposes through its `codex_apps` server.
 *
 * Managed runs pass `--dangerously-bypass-approvals-and-sandbox`, and under
 * that approval policy Codex auto-approves every app tool call whatever its
 * `approval_mode` is, so approval modes cannot gate a send. Instead we turn
 * off the tools that can act on the outside world: Codex disables an app tool
 * when it carries `destructive_hint` or `open_world_hint` (a missing hint
 * counts as true) and the matching `apps._default.*_enabled` flag is false.
 * Read-only tools stay available. Sends go through a GSAM connection, whose
 * tool gateway posts an approval card and runs the exact approved call once.
 *
 * Codex applies these defaults at tool exposure and again at call time.
 */
export const CODEX_MANAGED_LINKED_APPS_DEFAULTS = {
  destructive_enabled: false,
  open_world_enabled: false,
} as const;

/** `-c` overrides for the Codex CLI lane. Append after operator extraArgs so they win. */
export function codexManagedLinkedAppsConfigArgs(): string[] {
  return Object.entries(CODEX_MANAGED_LINKED_APPS_DEFAULTS).flatMap(([key, value]) => [
    "-c",
    `apps._default.${key}=${value}`,
  ]);
}

/**
 * Merges the policy into a `CODEX_CONFIG` JSON object for the ACP lane
 * (codex-acp passes it to Codex as session config). Other operator keys,
 * including other `apps` entries, are kept; the managed defaults always win.
 */
export function withCodexManagedLinkedAppsConfig(existing: string | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (existing) {
    try {
      parsed = parseObject(JSON.parse(existing));
    } catch {
      parsed = {};
    }
  }
  const apps = parseObject(parsed.apps);
  return JSON.stringify({
    ...parsed,
    apps: {
      ...apps,
      _default: { ...parseObject(apps._default), ...CODEX_MANAGED_LINKED_APPS_DEFAULTS },
    },
  });
}
