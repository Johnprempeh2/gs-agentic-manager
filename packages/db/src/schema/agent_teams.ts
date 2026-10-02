import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

// A named group of agents (GRE-436). Teams sit beside the reporting line
// (`agents.reports_to`); they never change who reports to whom or how agents
// claim work. An agent may belong to more than one team.
export const agentTeams = pgTable(
  "agent_teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    description: text("description"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agent_teams_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("agent_teams_company_name_uq").on(table.companyId, table.name),
  }),
);

export const agentTeamMembers = pgTable(
  "agent_team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull().references(() => agentTeams.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamAgentUq: uniqueIndex("agent_team_members_team_agent_uq").on(table.teamId, table.agentId),
    companyIdx: index("agent_team_members_company_idx").on(table.companyId),
    agentIdx: index("agent_team_members_agent_idx").on(table.agentId),
  }),
);
