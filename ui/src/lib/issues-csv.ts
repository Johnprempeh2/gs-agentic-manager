import type { Issue } from "@greatstone/shared";

/**
 * "Download as spreadsheet" on task lists: the tasks the list shows, as a CSV
 * that opens cleanly in Excel, Numbers and Google Sheets.
 */

export interface IssuesCsvLookups {
  statusLabel: (status: Issue["status"]) => string;
  agentName: (agentId: string) => string | null | undefined;
  userLabel: (userId: string) => string | null | undefined;
  projectName: (projectId: string) => string | null | undefined;
  /** Absolute link to a task, for the Link column. */
  taskUrl: (issue: Issue) => string;
}

export const ISSUES_CSV_HEADERS = [
  "Key",
  "Title",
  "Status",
  "Priority",
  "Responsible",
  "Project",
  "Due date",
  "Created",
  "Last updated",
  "Completed",
  "Link",
] as const;

/**
 * Quote a cell when it needs it, and defuse text a spreadsheet would run as a
 * formula (a leading =, +, - or @).
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? "";
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function isoDay(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function capitalise(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** One row per task, in the order of ISSUES_CSV_HEADERS. */
export function issuesToRows(issues: readonly Issue[], lookups: IssuesCsvLookups): string[][] {
  return issues.map((issue) => {
    const responsible = issue.assigneeAgentId
      ? lookups.agentName(issue.assigneeAgentId) ?? ""
      : issue.assigneeUserId
        ? lookups.userLabel(issue.assigneeUserId) ?? ""
        : "";
    return [
      issue.identifier ?? "",
      issue.title,
      lookups.statusLabel(issue.status),
      capitalise(issue.priority ?? ""),
      responsible,
      issue.projectId ? lookups.projectName(issue.projectId) ?? "" : "",
      issue.dueDate ?? "",
      isoDay(issue.createdAt),
      isoDay(issue.updatedAt),
      isoDay(issue.completedAt),
      lookups.taskUrl(issue),
    ];
  });
}

export function issuesToCsv(issues: readonly Issue[], lookups: IssuesCsvLookups): string {
  const rows = issuesToRows(issues, lookups);
  // The byte order mark makes Excel read the file as UTF-8, so names keep their accents.
  return `﻿${[ISSUES_CSV_HEADERS as readonly string[], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** "gre-tasks-2026-10-15.csv" */
export function issuesCsvFileName(prefix: string | null | undefined, today: string): string {
  const slug = (prefix ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug ? `${slug}-` : ""}tasks-${today}.csv`;
}

export function downloadTextFile(fileName: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
