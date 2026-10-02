import { z } from "zod";

/**
 * A named group of agents (GRE-436). Teams sit beside the reporting line:
 * they never change who reports to whom or how agents claim tasks. An agent
 * may be in more than one team. The lead, when set, is always a member.
 */
export interface AgentTeam {
  id: string;
  companyId: string;
  name: string;
  /** 6-digit hex, e.g. "#2563eb". */
  color: string;
  description: string | null;
  leadAgentId: string | null;
  memberAgentIds: string[];
  createdAt: Date | string;
  updatedAt: Date | string;
}

const agentTeamColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value");

const memberAgentIdsSchema = z.array(z.string().guid()).max(500);

export const createAgentTeamSchema = z.object({
  name: z.string().trim().min(1).max(64),
  color: agentTeamColorSchema,
  description: z.string().trim().max(2_000).optional().nullable(),
  leadAgentId: z.string().guid().optional().nullable(),
  memberAgentIds: memberAgentIdsSchema.optional(),
});

export type CreateAgentTeam = z.infer<typeof createAgentTeamSchema>;

/** Every field is optional; `memberAgentIds`, when sent, replaces the member list. */
export const updateAgentTeamSchema = createAgentTeamSchema.partial();

export type UpdateAgentTeam = z.infer<typeof updateAgentTeamSchema>;

export const addAgentTeamMemberSchema = z.object({
  agentId: z.string().guid(),
});

export type AddAgentTeamMember = z.infer<typeof addAgentTeamMemberSchema>;

/** Colours offered when creating a team. Any 6-digit hex is accepted. */
export const AGENT_TEAM_COLORS = [
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#4b5563",
] as const;
