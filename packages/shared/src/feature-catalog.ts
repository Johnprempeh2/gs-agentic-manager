import { z } from "zod";
import { instanceExperimentalSettingsSchema } from "./validators/instance.js";

/**
 * Feature catalog for cloud-managed instances.
 *
 * The instance-settings zod schema is the feature manifest; this module adds
 * only metadata about the flags the schema already declares. Keys are derived
 * from the schema type, so adding, removing, or renaming a boolean flag in
 * `instanceExperimentalSettingsSchema` without updating the metadata map is a
 * compile error (and vice versa).
 *
 * Tiers:
 * - `preference`: tenant-controllable taste setting; the cloud harness does
 *   not manage it.
 * - `managed`: the cloud harness may set this per fleet/stack via
 *   `GSAM_MANAGED_CONFIG`.
 * - `floor`: pinned by code on managed instances; no flag value may widen it.
 */
export const FEATURE_TIERS = ["preference", "managed", "floor"] as const;

export type FeatureTier = (typeof FEATURE_TIERS)[number];

type ExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;

/**
 * The boolean flag keys of the experimental settings schema. Non-flag keys
 * (activation timestamps, numeric tuning values) are excluded.
 */
export type InstanceFeatureKey = {
  [K in keyof ExperimentalSettings]: ExperimentalSettings[K] extends boolean ? K : never;
}[keyof ExperimentalSettings];

export interface FeatureCatalogEntry {
  title: string;
  description: string;
  tier: FeatureTier;
  /** Desired default on cloud-managed instances. */
  cloudDefault: boolean;
  /** Must match the schema default; enforced by test. */
  selfHostedDefault: boolean;
}

export const INSTANCE_FEATURE_CATALOG: Record<InstanceFeatureKey, FeatureCatalogEntry> = {
  enableEnvironments: {
    title: "Environments (compatibility)",
    description:
      "Deprecated compatibility key. Environment management is always enabled; stored values are ignored. A managed config or the entitlement document can still turn it off.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableNativeRunner: {
    title: "GS Agentic Manager Runner (compatibility)",
    description:
      "Deprecated compatibility key. The GS Agentic Manager Runner is always enabled; stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    // Always on (GRE-1436). `pnpm dev` builds runnerd, so it needs a Rust
    // toolchain or GSAM_RUNNER_BINARY.
    selfHostedDefault: true,
  },
  enableManagedSandboxOnly: {
    title: "Managed Environment Only",
    description:
      "Hide the local environment and run all agents in the platform-managed environment.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIsolatedWorkspaces: {
    title: "Isolated Workspaces (compatibility)",
    description:
      "Deprecated compatibility key. Isolated workspaces are always enabled; stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableIsolatedWorkspacesByDefault: {
    title: "Isolated Workspaces By Default",
    description:
      "Treat a project that has no execution workspace policy of its own as if it selected isolated workspaces, so its tasks get a per-task worktree instead of sharing the project checkout. A project that carries its own policy keeps it.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableStreamlinedLeftNavigation: {
    title: "Streamlined Left Navigation",
    description: "Use the streamlined main sidebar navigation layout.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableStreamlinedUi: {
    title: "Streamlined UI (compatibility)",
    description:
      "Deprecated compatibility key. The streamlined UI is always on (GRE-1441); stored and managed values are ignored.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableApps: {
    title: "Apps (compatibility)",
    description:
      "Deprecated compatibility key. Apps is always enabled; stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableChatConnectors: {
    title: "Chat connectors (compatibility)",
    description:
      "Deprecated compatibility key. Chat connectors are always enabled (GRE-1620); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableMemoryConnectors: {
    title: "Memory connectors (compatibility)",
    description:
      "Deprecated compatibility key. Memory connectors are always enabled (GRE-1620); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableMcpAggregators: {
    title: "MCP aggregators (compatibility)",
    description: "Deprecated compatibility key. MCP aggregators are always enabled; stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enablePipelines: {
    title: "Pipelines",
    description: "Enable pipeline definitions and pipeline-driven case production surfaces.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableCases: {
    title: "Cases (compatibility)",
    description:
      "Deprecated compatibility key. Cases are always enabled (GRE-1622); stored values are ignored. A managed config or the entitlement document can still turn it off.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableDeepDive: {
    title: "Deep Dive",
    description:
      "Record a client deep dive as Cases: the nine Investigation Streams by the five GIF questions, with depth, status and visibility per stream.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableStrategy: {
    title: "Strategy",
    description:
      "The strategy module: the one-page strategic plan (vision to KPI cascade), KPI readings with RAG status, and KPI drafts from a research pack. Plain goals stay on without it. Off answers the KPI routes with 403 not_entitled.",
    tier: "managed",
    cloudDefault: false,
    // On for self-hosted so existing instances keep their plan; client
    // editions pin it off and the signed entitlement document governs it.
    selfHostedDefault: true,
  },
  enableStrategyBoard: {
    title: "Board control panel",
    description:
      "Requires Strategy. The board's view of the strategy: status by area, biggest slippages first, changes since the last board pack, slippage alerts to the chair, \"Why?\" requests and the quarterly board pack.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableWebsiteView: {
    title: "Website view",
    description:
      "Read-only Website page built from Google Analytics 4 and Search Console: Google sign-in with read-only scopes, a daily pull stored in this instance, and the report API. Off answers every Website route with 403 not_entitled.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIntelligence: {
    title: "Intelligence",
    description:
      "The Intelligence page: the Daily Pulse brief, the AI leaderboards with movement, compare, radar and news, plus GSAM feature and skill recommendations. An agent writes it through the API. Off answers every Intelligence route with 403 not_entitled.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableAgentChat: {
    title: "Agent Chat (compatibility)",
    description:
      "Deprecated compatibility key. Agent Chat is always on (GRE-1621); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableTeamChat: {
    title: "Team Chat",
    description:
      "Direct messages between people and group chats of people and agents. Agents in a group reply only when @mentioned, and can turn an ask into a linked task.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableConferenceRoomChat: {
    title: "Conference Room Chat (compatibility)",
    description:
      "Deprecated compatibility key. Conference Room Chat is always on (GRE-1624); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableClassicTaskInterface: {
    title: "Classic Task Interface",
    description:
      "Restore the pre-chat task detail page: the page-level header with inline description editor, the plain comment thread, and the fixed Properties sidebar. Chat-only features (streaming activity folding, inline plan/question cards, the three-mode composer) are unavailable in the classic view.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIssuePlanDecompositions: {
    title: "Task Plan Decomposition (compatibility)",
    description:
      "Deprecated compatibility key. Accepted-plan decomposition history always shows on task detail pages (GRE-1621); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableExperimentalFileViewer: {
    title: "File Viewer (compatibility)",
    description:
      "Deprecated compatibility key. The task file viewer is always enabled; stored and managed values are ignored.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableStatusCards: {
    title: "Status Cards (compatibility)",
    description:
      "Deprecated compatibility key. The status-card board, update engine and API are always enabled (GRE-1622); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableExternalObjects: {
    title: "External Objects (compatibility)",
    description:
      "Deprecated compatibility key. External object detection and status are always enabled (GRE-1622); stored values are ignored. A managed config or the entitlement document can still turn it off.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableSmokeLab: {
    title: "Smoke Lab",
    description:
      "Add the Smoke Lab tab and dashboard card for exercising integration paths against deterministic local fixtures. Private deployments only.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableBuiltInAgents: {
    title: "Built-in Agents (compatibility)",
    description:
      "Deprecated compatibility key. Built-in agent surfaces are always on (GRE-1621); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableBetaSkills: {
    title: "Beta skills (compatibility)",
    description:
      "Deprecated compatibility key. Agents can always pin beta releases of the GS Agentic Manager core skill (GRE-1621); stored values are ignored.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableSummaries: {
    title: "Summaries (compatibility)",
    description:
      "Deprecated compatibility key. Summary slots are always enabled (GRE-1622); stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableDecisions: {
    title: "Decisions",
    description:
      "Show the Decisions item in the main sidebar: the attention home that surfaces tasks awaiting input.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: true,
  },
  enableGoalsSidebarLink: {
    title: "Goals Sidebar Link",
    description: "Restore the Goals item in the main sidebar while the goals surface is being evaluated.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableSimplifiedEnglishInteractions: {
    title: "Simplified English Interactions (compatibility)",
    description:
      "Deprecated compatibility key. Agents always write user interactions in ASD-STE100 Simplified Technical English (GRE-1621); stored values are ignored.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableServerInfoDebugView: {
    title: "Server Info Debug View (compatibility)",
    description:
      "Deprecated compatibility key. The Server section in the account drawer always shows; stored and managed values are ignored.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enablePaperclipDeveloperMode: {
    title: "GS Agentic Manager Developer Mode",
    description:
      "Show internal GS Agentic Manager maintainer tools and observability links, including Honeycomb trace queries on run pages.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  autoRestartDevServerWhenIdle: {
    title: "Auto-Restart Dev Server When Idle",
    description:
      "In local development, wait for queued and running agent runs to finish, then restart the server automatically when backend changes make the current boot stale.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableWorkspaceBranchReconcileForward: {
    title: "Workspace Branch Reconcile Forward (compatibility)",
    description:
      "Deprecated compatibility key. Execution workspaces always reconcile a diverged recorded branch forward when it is safe; stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableWorkspaceDirtyQuarantineRepair: {
    title: "Workspace Dirty Quarantine Repair (compatibility)",
    description:
      "Deprecated compatibility key. Workspace runtime recovery always quarantines and repairs dirty execution workspaces before runs when it is safe; stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableOwnerInstanceAdmin: {
    title: "Owner Instance Admin",
    description:
      "On cloud-managed instances, grant the stack owner instance-admin access to their own dedicated instance. Elevation is computed at the trusted-header auth boundary; no instance admin role rows are created. Inert on self-hosted instances.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: false,
  },
  enableSandboxDuplexBridge: {
    title: "Sandbox Duplex Bridge",
    description:
      "Let a run open the sandbox duplex command-stream bridge when the provider grants the capability. The host reads this per run before it selects the transport. Off keeps the file bridge for every run.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableRunnerPreviewIngress: {
    title: "Runner Preview Ingress (Deprecated)",
    description:
      "Compatibility-only key retained for older managed configs. Runner ingress follows the GS Agentic Manager Runner setting.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableWorktreeRunExecution: {
    title: "Worktree Run Execution",
    description:
      "Let the scheduler execute runs inside an isolated git-worktree preview instance for tasks created after activation.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableFirstTaskPlanProposal: {
    title: "First task: propose with a plan document",
    description:
      "When the user's first request is a single task, the chief of staff writes a short plan document and a checkbox card instead of a one-card confirmation. Applies to organizations created after the toggle is flipped.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
};

export const INSTANCE_FEATURE_KEYS = Object.keys(INSTANCE_FEATURE_CATALOG).sort() as InstanceFeatureKey[];

/**
 * Switches that only work with another switch on (GRE-1382, D2 rule 1 on
 * GRE-1354): the Board add-on needs the Strategy module. The server reads a
 * dependent switch as off while what it needs is off, and refuses a settings
 * write that would leave it on alone.
 */
export const INSTANCE_FEATURE_REQUIRES: Partial<Record<InstanceFeatureKey, InstanceFeatureKey>> = {
  enableStrategyBoard: "enableStrategy",
};

export interface FeatureDependencyViolation {
  feature: InstanceFeatureKey;
  requires: InstanceFeatureKey;
}

/** Dependent switches that are on while the switch they need is off. */
export function featureDependencyViolations(
  settings: Partial<Record<InstanceFeatureKey, unknown>>,
): FeatureDependencyViolation[] {
  return (Object.entries(INSTANCE_FEATURE_REQUIRES) as Array<[InstanceFeatureKey, InstanceFeatureKey]>)
    .filter(([feature, requires]) => settings[feature] === true && settings[requires] !== true)
    .map(([feature, requires]) => ({ feature, requires }));
}

/** Reads each dependent switch as off while the switch it needs is off. */
export function applyFeatureDependencies<T extends Partial<Record<InstanceFeatureKey, unknown>>>(settings: T): T {
  const violations = featureDependencyViolations(settings);
  if (violations.length === 0) return settings;
  const next = { ...settings } as Record<string, unknown>;
  for (const { feature } of violations) next[feature] = false;
  return next as T;
}

/**
 * Greatstone: flags retired from Settings > Experimental (GRE-193 / GRE-196).
 * The feature code stays in place so upstream merges stay easy, but the
 * switch is hidden and the flag always reads as off — a stored or managed
 * "on" value cannot turn it back on.
 */
export const RETIRED_INSTANCE_FEATURE_KEYS = [
  "enableClassicTaskInterface",
  "enableSmokeLab",
  "enablePaperclipDeveloperMode",
  "autoRestartDevServerWhenIdle",
] as const satisfies readonly InstanceFeatureKey[];

export type RetiredInstanceFeatureKey = (typeof RETIRED_INSTANCE_FEATURE_KEYS)[number];

export function isRetiredInstanceFeatureKey(key: string): key is RetiredInstanceFeatureKey {
  return (RETIRED_INSTANCE_FEATURE_KEYS as readonly string[]).includes(key);
}

/**
 * Greatstone: flags graduated out of Settings > Experimental (GRE-848).
 * The feature is always on, so the switch is hidden; each entry names the
 * issue that graduated it. Beta tools report these as `graduated`.
 */
export const GRADUATED_INSTANCE_FEATURE_KEYS = [
  { key: "enableAgentChat", issue: "GRE-1621" },
  { key: "enableApps", issue: "upstream #12728" },
  { key: "enableBetaSkills", issue: "GRE-1621" },
  { key: "enableBuiltInAgents", issue: "GRE-1621" },
  { key: "enableCases", issue: "GRE-1622" },
  { key: "enableChatConnectors", issue: "GRE-1620" },
  { key: "enableConferenceRoomChat", issue: "GRE-1624" },
  { key: "enableEnvironments", issue: "GRE-1623" },
  { key: "enableExperimentalFileViewer", issue: "GRE-1623" },
  { key: "enableExternalObjects", issue: "GRE-1622" },
  { key: "enableGoalsSidebarLink", issue: "GRE-191" },
  { key: "enableIsolatedWorkspaces", issue: "GRE-1437" },
  { key: "enableIssuePlanDecompositions", issue: "GRE-1621" },
  { key: "enableMcpAggregators", issue: "upstream #12728" },
  { key: "enableMemoryConnectors", issue: "GRE-1620" },
  { key: "enableNativeRunner", issue: "GRE-1436" },
  { key: "enableServerInfoDebugView", issue: "GRE-1623" },
  { key: "enableSimplifiedEnglishInteractions", issue: "GRE-1621" },
  { key: "enableStatusCards", issue: "GRE-1622" },
  { key: "enableStreamlinedLeftNavigation", issue: "GRE-1440" },
  { key: "enableStreamlinedUi", issue: "GRE-1441" },
  { key: "enableSummaries", issue: "GRE-1622" },
  { key: "enableWorkspaceBranchReconcileForward", issue: "GRE-1438" },
  { key: "enableWorkspaceDirtyQuarantineRepair", issue: "GRE-1439" },
] as const satisfies readonly { key: InstanceFeatureKey; issue: string }[];

export type GraduatedInstanceFeatureKey = (typeof GRADUATED_INSTANCE_FEATURE_KEYS)[number]["key"];

export function isGraduatedInstanceFeatureKey(key: string): key is GraduatedInstanceFeatureKey {
  return GRADUATED_INSTANCE_FEATURE_KEYS.some((entry) => entry.key === key);
}

/**
 * Shape of the `feature-catalog.json` release artifact the cloud harness
 * imports per app release and validates feature writes against.
 */
export const featureCatalogArtifactSchema = z
  .object({
    catalogVersion: z.string().min(1),
    features: z.record(
      z.string().min(1),
      z.object({ tier: z.enum(FEATURE_TIERS) }).strict(),
    ),
  })
  .strict();

export type FeatureCatalogArtifact = z.infer<typeof featureCatalogArtifactSchema>;

export function buildFeatureCatalogArtifact(catalogVersion: string): FeatureCatalogArtifact {
  if (catalogVersion.trim().length === 0) {
    throw new Error("catalogVersion must be a non-empty string");
  }
  const features: FeatureCatalogArtifact["features"] = {};
  for (const key of INSTANCE_FEATURE_KEYS) {
    features[key] = { tier: INSTANCE_FEATURE_CATALOG[key].tier };
  }
  return { catalogVersion, features };
}

/** Deterministic serialization (sorted keys, trailing newline) for the artifact file. */
export function renderFeatureCatalogArtifact(catalogVersion: string): string {
  return `${JSON.stringify(buildFeatureCatalogArtifact(catalogVersion), null, 2)}\n`;
}
