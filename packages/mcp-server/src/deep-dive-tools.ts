import { z } from "zod";
import {
  DEEP_DIVE_DRAFT_STATUSES,
  deepDiveInterviewLogSchema,
  deepDiveRecordProposalSchema,
  mcpToolHints,
} from "@greatstone/shared";
import type { PaperclipApiClient } from "./client.js";
import { makeTool, type ToolDefinition } from "./tools.js";

// Deep Dive draft tools (GRE-4430), the GSAM home of indago-portal PR #31's
// log_interview and propose_record. Every call names one client's Deep Dive;
// the API refuses a Deep Dive outside the agent's company. Agents write drafts
// only: there is no approve, publish or delete tool. Named like the studio
// tools, outside tools.ts, so the frozen paperclip* inventory is unchanged.

const companyId = z.string().guid().optional().nullable();
const recordId = z.string().guid().describe("The Deep Dive's id from deep_dive_list (one client engagement).");
const revise = {
  draftId: z.string().guid().optional().describe("Change this open draft instead of making a new one."),
  expectedVersion: z.number().int().min(1).optional().describe("Needed with draftId: the version you last read."),
};

const LOG_INTERVIEW_DESCRIPTION = [
  "Save one interview from a Notion meeting transcript as a DRAFT in a client's Deep Dive, for a person to approve in GSAM.",
  "Run it only when someone asked you to log that interview. List every question asked, in order: status answered",
  "(answer plus quote, the speaker's exact words, two sentences at most), unclear (something was said but it did not",
  "answer) or not_answered (skipped). Never guess. Talk that answers no question goes in outsideNotes.",
  "Group each item under one of the Deep Dive's workstreams (from deep_dive_list) and tag pillars when clear.",
  "interviewee: name and role as written in Notion, no contact details.",
].join(" ");

export function deepDiveTools(client: PaperclipApiClient): ToolDefinition[] {
  const base = (company: string | null | undefined) => `/companies/${client.resolveCompanyId(company)}`;
  const scoped = (company: string | null | undefined, path: string, record: string) =>
    `${base(company)}/deep-dive/${path}?recordId=${encodeURIComponent(record)}`;

  return [
    makeTool(
      "deep_dive_list",
      "List every client's Deep Dive (one per engagement) with its id, client, workstreams and drafts waiting for review.",
      mcpToolHints("read"),
      z.object({ companyId }),
      async ({ companyId: company }) => client.requestJson("GET", `${base(company)}/deep-dives`),
    ),
    makeTool(
      "deep_dive_list_drafts",
      "List one Deep Dive's agent drafts with their status (draft, approved, rejected) and version.",
      mcpToolHints("read"),
      z.object({ companyId, recordId, status: z.enum(DEEP_DIVE_DRAFT_STATUSES).optional() }),
      async ({ companyId: company, recordId: record, status }) =>
        client.requestJson("GET", scoped(company, "drafts", record) + (status ? `&status=${status}` : "")),
    ),
    makeTool(
      "deep_dive_get_draft",
      "Read one draft of a Deep Dive in full, with the reviewer's note once it is decided.",
      mcpToolHints("read"),
      z.object({ companyId, recordId, draftId: z.string().guid() }),
      async ({ companyId: company, recordId: record, draftId }) =>
        client.requestJson("GET", scoped(company, `drafts/${encodeURIComponent(draftId)}`, record)),
    ),
    makeTool(
      "deep_dive_log_interview",
      LOG_INTERVIEW_DESCRIPTION,
      mcpToolHints("write"),
      z.object({ companyId, recordId, ...revise, interview: deepDiveInterviewLogSchema }),
      async ({ companyId: company, recordId: record, interview, draftId, expectedVersion }) =>
        client.requestJson("POST", scoped(company, "drafts/interview-log", record), {
          body: { interview, ...(draftId ? { draftId, expectedVersion } : {}) },
        }),
    ),
    makeTool(
      "deep_dive_propose_record",
      "Propose a new register row for a client's Deep Dive (for example a risk, a decision or an evidence entry) as a DRAFT. It counts only once a person approves it.",
      mcpToolHints("write"),
      z.object({ companyId, recordId, ...revise, title: z.string().trim().min(1).max(200), proposal: deepDiveRecordProposalSchema }),
      async ({ companyId: company, recordId: record, title, proposal, draftId, expectedVersion }) =>
        client.requestJson("POST", scoped(company, "drafts/record-proposal", record), {
          body: { title, proposal, ...(draftId ? { draftId, expectedVersion } : {}) },
        }),
    ),
  ];
}
