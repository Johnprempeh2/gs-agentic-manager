import type { z } from "zod";
import type { workflowTemplateDefinitionSchema } from "../validators/workflow-template.js";

export type WorkflowTemplateDefinition = z.infer<typeof workflowTemplateDefinitionSchema>;

export interface WorkflowTemplate {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  definition: WorkflowTemplateDefinition;
  archivedAt: Date | string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface WorkflowTemplateStartedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  documentKeys: string[];
}

export interface WorkflowTemplateStartedStep extends WorkflowTemplateStartedIssue {
  stepKey: string;
  blockedByStepKeys: string[];
  /** Review keys in the order their stages run on this step. */
  reviewKeys: string[];
}

export interface WorkflowTemplateStartResult {
  templateId: string;
  coordinator: WorkflowTemplateStartedIssue;
  steps: WorkflowTemplateStartedStep[];
}

/**
 * Starting point for the research pack workflow (scope rev 3, GRE-1137, section 2.2).
 * Generic on purpose: no client names, no agents. A company copies it into its own
 * template, then sets assignees and reviewers.
 */
export const RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET: {
  key: string;
  name: string;
  description: string;
  definition: WorkflowTemplateDefinition;
} = {
  key: "research-pack",
  name: "Research pack",
  description: "Pre-workshop research pack: five-slide pre-read plus an evidence file, with three human checks.",
  definition: {
    version: 1,
    coordinator: {
      description:
        "Coordinator for one research pack. Steps 2-5 run in parallel after the scope check (R1). " +
        "Every claim gets a stable claim ID in the evidence table; later steps cite claim IDs only. Agents never send anything to the client.",
      assigneeAgentId: null,
      documents: [],
    },
    steps: [
      {
        key: "intake",
        title: "Intake",
        description: "Fill the intake form: company, sector, countries, size, workshop date, the 3-5 questions to answer, records provided, what is off-limits.",
        assigneeAgentId: null,
        documents: [{ key: "intake", title: "Intake" }],
        blockedBy: [],
      },
      {
        key: "records",
        title: "Read client records and open the evidence table",
        description: "Extract facts into the fact sheet. Each fact gets a claim ID with source, page, date and confidence in the evidence table.",
        assigneeAgentId: null,
        documents: [
          { key: "fact-sheet", title: "Fact sheet" },
          { key: "evidence", title: "Evidence" },
        ],
        blockedBy: ["intake"],
      },
      {
        key: "analogues",
        title: "Search past engagements",
        description: "Find the 3-5 most similar engagement cards (sector, country, size, problem). Pull lessons and KPIs used.",
        assigneeAgentId: null,
        documents: [{ key: "analogues", title: "Analogues" }],
        blockedBy: ["intake"],
      },
      {
        key: "environment",
        title: "Environment scan",
        description: "PESTEL for the sector and countries, 5-10 dated facts, local regulatory check per country (prompts for counsel, not advice).",
        assigneeAgentId: null,
        documents: [{ key: "environment", title: "Environment" }],
        blockedBy: ["intake"],
      },
      {
        key: "benchmarks",
        title: "Global benchmarks",
        description: "3-5 peers: margins, growth, operating ratios, each with denominator, segment and year. Context, not targets.",
        assigneeAgentId: null,
        documents: [{ key: "benchmarks", title: "Benchmarks" }],
        blockedBy: ["intake"],
      },
      {
        key: "synthesis",
        title: "Synthesis",
        description: "Write the five slides from the step documents only. Start each bullet with its bold ID (e.g. **S1**), then record its claim IDs and labels " +
          "(type, geography, freshness, inference, suggested judgement) with PUT /api/issues/{this issue}/documents/pre-read/evidence.",
        assigneeAgentId: null,
        documents: [{ key: "pre-read", title: "Pre-read" }],
        blockedBy: ["records", "analogues", "environment", "benchmarks"],
      },
      {
        key: "check",
        title: "Check",
        description: "Check each bullet against its source and sort each flag: fail, label missing, or judgement. " +
          "Start from GET /api/issues/{synthesis issue}/documents/pre-read/evidence: it lists bullets with no source or a missing label.",
        assigneeAgentId: null,
        documents: [{ key: "check-report", title: "Check report" }],
        blockedBy: ["synthesis"],
      },
      {
        key: "deck",
        title: "Build the deck",
        description: "Apply the five-slide template and attach the evidence file. Put each slide's source notes in its notes field from " +
          "GET /api/issues/{synthesis issue}/documents/pre-read/evidence/export (sections[].notes; sources for the appendix).",
        assigneeAgentId: null,
        documents: [],
        blockedBy: ["check"],
      },
    ],
    reviews: [
      { key: "r1", label: "R1 Scope check", stepKey: "intake", type: "approval", participants: [] },
      { key: "r2", label: "R2 Fact sign-off", stepKey: "check", type: "approval", participants: [] },
      { key: "r3", label: "R3 Send approval", stepKey: "deck", type: "approval", participants: [] },
    ],
  },
};
