export interface ActivityEvent {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  responsibleUserId?: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
  /** For a row about a task: its identifier and title, when the company list returns them. */
  issueIdentifier?: string | null;
  issueTitle?: string | null;
}
