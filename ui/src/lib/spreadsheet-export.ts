import {
  ORGANISATION_STATUS_LABELS,
  type Issue,
  type IssueStatus,
  type OrganisationListItem,
  type WeeklyReport,
} from "@greatstone/shared";
import { ISSUES_CSV_HEADERS, csvCell, issuesToRows, type IssuesCsvLookups } from "./issues-csv";
import { createZipArchive } from "./zip";
import { daysInStage, readCardSummary, readDevtoolsDeal } from "./client-case";

/**
 * Spreadsheet downloads for Settings > Integrations and the Organisations list:
 * clients, tasks and the This week numbers as CSV or as an Excel workbook, so
 * anything can go into a spreadsheet without an API. Everything is built in
 * the browser from data the page already loads.
 */

export type SheetCell = string | number | null | undefined;

export interface Sheet {
  /** Tab name in Excel. */
  name: string;
  headers: string[];
  rows: SheetCell[][];
}

function cellText(value: SheetCell) {
  return value === null || value === undefined ? "" : String(value);
}

/** One sheet as CSV that opens cleanly in Excel, Numbers and Google Sheets. */
export function sheetToCsv(sheet: Sheet): string {
  const lines = [sheet.headers, ...sheet.rows].map((row) => row.map((value) => csvCell(cellText(value))).join(","));
  // The byte order mark makes Excel read the file as UTF-8, so names keep their accents.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** "A", "B", ... "Z", "AA" for a zero-based column. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function xmlText(value: string) {
  return value
    // Characters XML 1.0 does not allow; a spreadsheet would refuse the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Excel caps a cell at 32,767 characters. */
const CELL_MAX = 32_767;

function sheetXml(sheet: Sheet) {
  const rows = [sheet.headers, ...sheet.rows].map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? ' s="1"' : "";
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
      const text = cellText(value);
      if (!text) return "";
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(text.slice(0, CELL_MAX))}</t></is></c>`;
    });
    return `<row r="${rowIndex + 1}">${cells.join("")}</row>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

/** A tab name Excel accepts: no []:*?/\ and at most 31 characters, unique in the workbook. */
function tabName(name: string, used: Set<string>) {
  const base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** An Excel workbook (.xlsx) with one tab per sheet and a bold, frozen header row. */
export function sheetsToXlsx(sheets: Sheet[]): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((sheet) => tabName(sheet.name, used));
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets
        .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("") +
      "</Types>",
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
    "xl/workbook.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((name, index) => `<sheet name="${xmlText(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") +
      "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>",
    "xl/styles.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>",
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheet);
  });
  return createZipArchive(files, "");
}

function isoDay(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

export function clientsSheet(rows: readonly OrganisationListItem[]): Sheet {
  return {
    name: "Clients",
    headers: ["Name", "Stage", "Industry", "Country", "Country owner", "Website", "Key contacts", "Key contact emails", "Contacts", "Source", "Added", "Last updated", "Notes"],
    rows: rows.map((row) => [
      row.name,
      ORGANISATION_STATUS_LABELS[row.status] ?? row.status,
      row.industry,
      row.country,
      row.countryOwner,
      row.website,
      row.keyContacts.map((contact) => (contact.role ? `${contact.name} (${contact.role})` : contact.name)).join("; "),
      row.keyContacts.map((contact) => contact.email).filter(Boolean).join("; "),
      row.contactCount,
      row.source,
      isoDay(row.createdAt),
      isoDay(row.updatedAt),
      row.notes,
    ]),
  };
}

export const TASK_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

export function tasksSheet(issues: readonly Issue[], lookups: IssuesCsvLookups): Sheet {
  return { name: "Tasks", headers: [...ISSUES_CSV_HEADERS], rows: issuesToRows(issues, lookups) };
}

const money = (cents: number) => Math.round(cents) / 100;

/** The This week numbers as one Measure and Value table: totals first, then each agent. */
export function weeklyNumbersSheet(report: WeeklyReport): Sheet {
  const rows: SheetCell[][] = [
    ["Week from", isoDay(report.since)],
    ["Week to", isoDay(report.generatedAt)],
    ["Tasks finished", report.finished.count],
    ["Tasks stuck", report.stuck.count],
    ["Waiting on you", report.needsYou.count],
    ["Clients or cases added", report.pipeline.added],
    ["Stage moves", report.pipeline.moved],
    ["Won", report.pipeline.won],
    ["Lost", report.pipeline.lost],
    ["Agent spend (USD)", money(report.costs.totalCents)],
  ];
  for (const agent of report.finished.agents) rows.push([`Tasks finished: ${agent.name}`, agent.finished]);
  for (const agent of report.costs.agents) rows.push([`Spend (USD): ${agent.name}`, money(agent.cents)]);
  return { name: "This week", headers: ["Measure", "Value"], rows };
}

export interface PipelineSheetCase {
  id: string;
  title: string;
  stageId?: string | null;
  fields?: Record<string, unknown> | null;
  stageEnteredAt?: Date | string | null;
}

export interface PipelineSheetLookups {
  stageName: (stageId: string | null | undefined) => string;
  /** Absolute link to a card, for the Link column. */
  caseUrl: (item: PipelineSheetCase) => string;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;

/**
 * The cards a pipeline board shows, one row each, with the deal fields a
 * Pipedrive user expects in a spreadsheet. Numbers stay numbers so Excel can
 * sum the Value and Weighted value columns.
 */
export function pipelineSheet(name: string, cases: readonly PipelineSheetCase[], lookups: PipelineSheetLookups, now = new Date()): Sheet {
  return {
    name: name.slice(0, 31) || "Pipeline",
    headers: ["Title", "Stage", "Deal status", "Value", "Currency", "Probability", "Weighted value", "Owner", "Expected close", "Next step on", "Next step", "Last activity", "Days in stage", "Link"],
    rows: cases.map((item) => {
      const deal = readDevtoolsDeal(item.fields);
      const probability = deal.probability == null ? null : Math.min(100, Math.max(0, deal.probability));
      const subject = typeof item.fields?.nextActivitySubject === "string" ? item.fields.nextActivitySubject.trim() : "";
      return [
        item.title,
        lookups.stageName(item.stageId),
        deal.status,
        deal.value == null ? null : roundMoney(deal.value),
        deal.currency,
        probability,
        deal.value != null && probability != null ? roundMoney((deal.value * probability) / 100) : null,
        deal.owner ?? readCardSummary(item.fields).owner,
        deal.expectedClose,
        deal.nextActivity,
        subject || readCardSummary(item.fields).nextAction,
        deal.lastActivity,
        daysInStage(item.stageEnteredAt, now),
        lookups.caseUrl(item),
      ];
    }),
  };
}

/** "gre-clients-2026-10-16.csv" */
export function exportFileName(prefix: string | null | undefined, what: string, today: string, extension: "csv" | "xlsx") {
  const slug = (prefix ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug ? `${slug}-` : ""}${what}-${today}.${extension}`;
}

/** Today in the viewer's time zone, as 2026-10-16. */
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function downloadBytes(fileName: string, bytes: Uint8Array, type = XLSX_TYPE) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
