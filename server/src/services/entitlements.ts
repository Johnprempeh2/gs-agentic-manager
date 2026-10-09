/**
 * Server-side entitlement gate for managed features (GRE-1077).
 *
 * A managed feature switch (tier "managed" in the feature catalog) used to be
 * enforced only in the UI for some features: the pipelines API answered every
 * call with the switch off. This module is the one server check: routes and
 * services call `assertEntitled` (or mount `requireEntitlement`) and a blocked
 * call gets a 403 with code `not_entitled` and the feature key.
 *
 * Entitlement reads the effective experimental settings, so the cloud managed
 * overlay and the self-hosted stored value both apply. How editions are set at
 * start-up does not change.
 *
 * `FEATURE_ENTITLEMENT_GATES` must name every catalog key. A new key without an
 * entry is a type error, and `entitlements-gate.test.ts` fails when a managed
 * key is not tier-consistent, when an `api` gate has no probes, or when a
 * probe does not answer 403 with the switch off.
 */

import type { RequestHandler } from "express";
import type { Db } from "@greatstone/db";
import { INSTANCE_FEATURE_CATALOG, type InstanceFeatureKey } from "@greatstone/shared";
import { forbidden, type HttpError } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";

export const NOT_ENTITLED_ERROR_CODE = "not_entitled";

/** One route the gate test calls with the switch off; it must answer 403 not_entitled. */
export interface EntitlementProbe {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  /** JSON body; defaults to `{}`. */
  body?: Record<string, unknown>;
}

export type FeatureEntitlementGate =
  /** Tenant taste setting; not an entitlement. */
  | { kind: "preference" }
  /** The feature has its own API; every listed probe is denied when the switch is off. */
  | { kind: "api"; probes: readonly EntitlementProbe[] }
  /** No API of its own: the switch is read where the behavior happens. */
  | { kind: "runtime"; reason: string }
  /** Known gap: an API exists but is not gated yet. Must name the follow-up issue. */
  | { kind: "pending"; followUp: string; reason: string };

const ID = "00000000-0000-4000-8000-000000000001";
const COMPANY = `/companies/${ID}`;

export const FEATURE_ENTITLEMENT_GATES: Record<InstanceFeatureKey, FeatureEntitlementGate> = {
  enablePipelines: {
    kind: "api",
    probes: [
      { method: "get", path: `${COMPANY}/pipelines` },
      { method: "post", path: `${COMPANY}/pipelines` },
      { method: "get", path: `${COMPANY}/pipelines-attention` },
      { method: "get", path: `${COMPANY}/case-events` },
      { method: "get", path: `${COMPANY}/review-cases` },
      { method: "post", path: `${COMPANY}/review-cases/bulk` },
      { method: "get", path: `/pipelines/${ID}` },
      { method: "patch", path: `/pipelines/${ID}` },
      { method: "post", path: `/pipelines/${ID}/cases` },
      { method: "get", path: `/cases/${ID}` },
      { method: "post", path: `/cases/${ID}/transition` },
      { method: "get", path: `/projects/${ID}/pipeline-cases` },
    ],
  },
  enableCases: {
    kind: "api",
    probes: [
      { method: "get", path: `${COMPANY}/cases` },
      { method: "post", path: `${COMPANY}/cases` },
    ],
  },
  enableStatusCards: {
    kind: "api",
    probes: [
      { method: "get", path: `${COMPANY}/status-cards` },
      { method: "post", path: `${COMPANY}/status-cards` },
    ],
  },
  enableSummaries: {
    kind: "api",
    probes: [{ method: "get", path: `${COMPANY}/summary-slots/project/status` }],
  },
  enableBuiltInAgents: {
    kind: "api",
    probes: [{ method: "get", path: `${COMPANY}/built-in-agents` }],
  },
  enableConferenceRoomChat: {
    kind: "api",
    probes: [{ method: "post", path: "/board/chat/stream" }],
  },
  enableChatConnectors: {
    kind: "api",
    probes: [
      { method: "get", path: "/chat-identity-links/preview?token=x" },
      { method: "post", path: "/chat-identity-links/confirm" },
      { method: "post", path: "/chat-identity-links/request-access" },
      { method: "get", path: "/slack/search/callback" },
      { method: "get", path: `${COMPANY}/slack/endpoints/${ID}/search` },
    ],
  },
  enableAgentChat: {
    kind: "api",
    probes: [
      { method: "get", path: `${COMPANY}/chats/agent` },
      { method: "post", path: `${COMPANY}/chats/agent` },
    ],
  },
  enableMemoryConnectors: {
    kind: "api",
    probes: [{ method: "get", path: `${COMPANY}/tools/apps/mem0/preflight` }],
  },
  enableExternalObjects: {
    kind: "api",
    probes: [
      { method: "get", path: `/issues/${ID}/external-objects` },
      { method: "post", path: `/issues/${ID}/external-objects/refresh` },
      { method: "get", path: `/issues/${ID}/external-object-summary` },
      { method: "post", path: `${COMPANY}/issues/external-object-summaries` },
      { method: "get", path: `/projects/${ID}/external-object-summary` },
    ],
  },
  enableIssuePlanDecompositions: {
    kind: "api",
    probes: [{ method: "get", path: `/issues/${ID}/accepted-plan-decompositions` }],
  },
  enableDeepDive: {
    kind: "api",
    probes: [
      { method: "get", path: `${COMPANY}/cases?types=deep_dive_stream` },
      { method: "post", path: `${COMPANY}/cases`, body: { caseType: "deep_dive", title: "Deep Dive" } },
    ],
  },
  enableEnvironments: {
    kind: "api",
    // Reads stay open: agent setup, onboarding and the project pickers list
    // environments with the switch off. Every write is refused.
    probes: [
      { method: "post", path: `${COMPANY}/environments` },
      { method: "post", path: `${COMPANY}/environments/probe-config` },
      { method: "patch", path: `/environments/${ID}` },
      { method: "delete", path: `/environments/${ID}` },
      { method: "post", path: `/environments/${ID}/probe` },
      { method: "post", path: `/environment-custom-image-setup-sessions/${ID}/cancel` },
    ],
  },
  enableSmokeLab: {
    kind: "runtime",
    reason: "Retired: always reads off. The smoke-lab service refuses every call through assertEntitled.",
  },
  enableNativeRunner: { kind: "runtime", reason: "Selects the runner per run in heartbeat and agent config." },
  enableManagedSandboxOnly: { kind: "runtime", reason: "Environment selection and project cwd writes read it." },
  enableIsolatedWorkspaces: { kind: "runtime", reason: "Workspace policy resolution reads it per run." },
  enableIsolatedWorkspacesByDefault: { kind: "runtime", reason: "Workspace policy resolution reads it per run." },
  enableApps: { kind: "runtime", reason: "Graduated: always on; stored and managed values are ignored." },
  enableMcpAggregators: { kind: "runtime", reason: "Graduated: always on; stored and managed values are ignored." },
  enableWorkspaceBranchReconcileForward: { kind: "runtime", reason: "Workspace realization reads it." },
  enableWorkspaceDirtyQuarantineRepair: { kind: "runtime", reason: "Workspace recovery reads it." },
  enableOwnerInstanceAdmin: { kind: "runtime", reason: "Read at the trusted-header auth boundary." },
  enableSandboxDuplexBridge: { kind: "runtime", reason: "Read per run before the sandbox transport is chosen." },
  enableRunnerPreviewIngress: { kind: "runtime", reason: "Deprecated: runner ingress follows enableNativeRunner." },
  enableWorktreeRunExecution: { kind: "runtime", reason: "The scheduler reads it per run." },
  enableStreamlinedLeftNavigation: { kind: "preference" },
  enableStreamlinedUi: { kind: "preference" },
  enableClassicTaskInterface: { kind: "preference" },
  enableExperimentalFileViewer: { kind: "preference" },
  enableBetaSkills: { kind: "preference" },
  enableDecisions: { kind: "preference" },
  enableGoalsSidebarLink: { kind: "preference" },
  enableSimplifiedEnglishInteractions: { kind: "preference" },
  enableServerInfoDebugView: { kind: "preference" },
  enablePaperclipDeveloperMode: { kind: "preference" },
  autoRestartDevServerWhenIdle: { kind: "preference" },
  enableFirstTaskPlanProposal: { kind: "preference" },
};

export function notEntitled(feature: InstanceFeatureKey): HttpError {
  return forbidden(`${INSTANCE_FEATURE_CATALOG[feature].title} is not enabled on this instance`, {
    code: NOT_ENTITLED_ERROR_CODE,
    feature,
  });
}

export type EntitlementSettingsReader = { getExperimental: () => Promise<Partial<Record<InstanceFeatureKey, unknown>>> };

function settingsReader(source: Db | EntitlementSettingsReader): EntitlementSettingsReader {
  return "getExperimental" in source ? source : instanceSettingsService(source);
}

export async function isEntitled(source: Db | EntitlementSettingsReader, feature: InstanceFeatureKey): Promise<boolean> {
  const experimental = await settingsReader(source).getExperimental();
  return experimental[feature] === true;
}

/** Throws 403 `not_entitled` naming `feature` when its switch is off. */
export async function assertEntitled(source: Db | EntitlementSettingsReader, feature: InstanceFeatureKey): Promise<void> {
  if (!(await isEntitled(source, feature))) throw notEntitled(feature);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Route middleware form of `assertEntitled`; mount with `router.use(paths, ...)`. */
export function requireEntitlement(source: Db | EntitlementSettingsReader, feature: InstanceFeatureKey): RequestHandler {
  return (_req, _res, next) => {
    assertEntitled(source, feature).then(() => next(), next);
  };
}

/** Like `requireEntitlement`, but reads (GET, HEAD, OPTIONS) pass with the switch off. */
export function requireEntitlementForWrites(
  source: Db | EntitlementSettingsReader,
  feature: InstanceFeatureKey,
): RequestHandler {
  const gate = requireEntitlement(source, feature);
  return (req, res, next) => (READ_METHODS.has(req.method) ? next() : gate(req, res, next));
}
