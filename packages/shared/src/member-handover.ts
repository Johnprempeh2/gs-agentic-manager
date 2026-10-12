import { z } from "zod";

/**
 * Hand over and remove: what a person leaving the company leaves behind, where
 * each thing goes, and the request that moves it. See
 * `server/src/services/member-handover.ts` and `doc/WHEN-SOMEONE-LEAVES.md`.
 */

export const MEMBER_HANDOVER_OVERRIDE_ACTIONS = [
  "leave",
  "unassign",
  "close",
  "clear",
  "use_personal_default",
  "use_shared_connection",
] as const;
export type MemberHandoverOverrideAction = (typeof MEMBER_HANDOVER_OVERRIDE_ACTIONS)[number];

export const memberHandoverOverrideSchema = z
  .object({
    itemRef: z.string().trim().min(1).max(200),
    toUserId: z.string().trim().min(1).max(200).optional(),
    toAgentId: z.string().uuid().optional(),
    action: z.enum(MEMBER_HANDOVER_OVERRIDE_ACTIONS).optional(),
    /** With `action: "use_shared_connection"` only: the shared AI account to use. */
    sharedGrantId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const targets = [value.toUserId, value.toAgentId, value.action].filter((entry) => entry !== undefined);
    if (targets.length !== 1) {
      ctx.addIssue({ code: "custom", message: "Give exactly one of toUserId, toAgentId or action" });
    }
    if (value.action === "use_shared_connection" ? !value.sharedGrantId : value.sharedGrantId !== undefined) {
      ctx.addIssue({ code: "custom", message: "sharedGrantId goes with action use_shared_connection only" });
    }
  });
export type MemberHandoverOverride = z.infer<typeof memberHandoverOverrideSchema>;

export const memberHandoverRequestSchema = z
  .object({
    successorUserId: z.string().trim().min(1).max(200),
    overrides: z.array(memberHandoverOverrideSchema).max(5000).default([]),
    dryRun: z.boolean(),
    /** Owner confirmation that the person's instance admin role should go too. */
    removeInstanceAdmin: z.boolean().optional(),
  })
  .strict();
export type MemberHandoverRequest = z.infer<typeof memberHandoverRequestSchema>;

export const memberHandoverRestoreSchema = z.object({}).strict();

export type MemberHandoverGroup = "work" | "requests" | "routines" | "agents" | "connections" | "access";

export type MemberHandoverItemKind =
  | "issue"
  | "interaction"
  | "routine"
  | "company_default"
  | "queued_runs"
  | "agent_ai"
  | "ai_connection"
  | "github_identity"
  | "tool_connection"
  | "connection_audience"
  | "memory_grants"
  | "permission_grants"
  | "membership"
  | "instance_admin"
  | "board_api_keys"
  | "sessions";

export type MemberHandoverAction =
  | { type: "move_to_user"; userId: string }
  | { type: "move_to_agent"; agentId: string }
  | { type: "unassign" }
  | { type: "close" }
  | { type: "leave" }
  | { type: "clear" }
  /** The agent keeps its AI setting; runs use the new responsible person's default account. */
  | { type: "keep_ai_setting" }
  /** The agent switches to the responsible person's own default account. */
  | { type: "use_personal_default" }
  | { type: "use_shared_connection"; connectionId: string; grantId: string; name: string }
  | { type: "revoke" }
  | { type: "remove" }
  | { type: "end" }
  | { type: "archive" }
  | { type: "suspend" }
  | { type: "keep" };

/** What a person may choose instead of the recommended action for one item. */
export type MemberHandoverChoice =
  | "user"
  | "agent"
  | MemberHandoverOverrideAction;

export interface MemberHandoverSharedAiAccount {
  connectionId: string;
  grantId: string;
  name: string;
  provider: string;
  method: string;
}

export interface MemberHandoverItem {
  /** Stable reference used by overrides, for example `issue:<id>` or `routine:<id>`. */
  ref: string;
  group: MemberHandoverGroup;
  kind: MemberHandoverItemKind;
  title: string;
  detail: string | null;
  /** An in-app path, for example `/issues/GRE-12`. */
  link: string | null;
  roles?: string[];
  count?: number;
  recommended: MemberHandoverAction;
  planned: MemberHandoverAction;
  choices: MemberHandoverChoice[];
  sharedAlternatives?: MemberHandoverSharedAiAccount[];
  blocker: string | null;
  warning: string | null;
}

export interface MemberHandoverReconnect {
  kind: "ai" | "github" | "tool" | "channel";
  name: string;
  detail: string;
}

export interface MemberHandoverPlan {
  dryRun: boolean;
  companyId: string;
  member: {
    membershipId: string;
    userId: string;
    name: string;
    email: string | null;
    role: string | null;
    status: string;
    isInstanceAdmin: boolean;
  };
  successor: { userId: string; name: string };
  items: MemberHandoverItem[];
  blockers: string[];
  warnings: string[];
  reconnect: MemberHandoverReconnect[];
  counts: Record<string, number>;
  /** Set after an executed handover: the task created for the successor. */
  handoverIssue: { id: string; identifier: string | null; title: string } | null;
}

export interface MemberHandoverRestoreResult {
  companyId: string;
  membershipId: string;
  userId: string;
  membershipStatus: { from: string; to: "active" };
  permissionGrantsRestored: number;
  instanceAdminRestored: boolean;
}

/** What the Members page may offer for one row. The server decides. */
export interface MemberHandoverControls {
  canHandOver: boolean;
  handOverReason: string | null;
  canRestore: boolean;
  restoreReason: string | null;
}
