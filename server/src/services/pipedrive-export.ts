// Reads the CSV files Pipedrive exports (organisations, people, deals,
// activities) into plain records, so the import works without an API key.
// Pipedrive names export columns after field labels, sometimes with the record
// type in front ("Organization - Name"), sometimes without ("Name"), and in
// the account's own spelling. Each field therefore has a list of accepted
// headers, compared after lower-casing and squashing spaces.
import type { MappedPipedriveContact, MappedPipedriveOrganisation } from "./organisation-import-pipedrive.js";

/** Thrown when a file cannot be read as a Pipedrive export. The message is shown to the person. */
export class PipedriveExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipedriveExportError";
  }
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside
 * quotes, CRLF or LF. Semicolon or tab files (Excel in some locales) are
 * detected from the header line. A leading byte order mark is dropped.
 */
export function parseCsv(input: string): string[][] {
  const textValue = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const firstLine = textValue.slice(0, textValue.search(/\r?\n|$/));
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<string, number>;
  let quoted = false;
  for (const char of firstLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char]! += 1;
  }
  const [best, bestCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  const delimiter = bestCount > 0 ? best : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < textValue.length; i += 1) {
    const char = textValue[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (textValue[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && textValue[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (inQuotes) throw new PipedriveExportError("The file ends inside a quoted value, so it looks cut short. Export it again.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function normaliseHeader(header: string) {
  return header
    .trim()
    .toLowerCase()
    .replace(/organisation/g, "organization")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " - ");
}

type Row = (aliases: string[]) => string | null;

/** Rows of a CSV as lookups by accepted header names. Empty cells read as null. */
export function csvRecords(input: string): { headers: string[]; rows: Row[] } {
  const [headerRow, ...dataRows] = parseCsv(input);
  if (!headerRow) return { headers: [], rows: [] };
  const headers = headerRow.map(normaliseHeader);
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    if (!index.has(header)) index.set(header, position);
  });
  const columnFor = (aliases: string[]) => {
    for (const alias of aliases) {
      const position = index.get(normaliseHeader(alias));
      if (position !== undefined) return position;
    }
    return undefined;
  };
  return {
    headers,
    rows: dataRows.map((cells) => (aliases: string[]) => {
      const position = columnFor(aliases);
      if (position === undefined) return null;
      const value = cells[position]?.trim() ?? "";
      return value === "" ? null : value;
    }),
  };
}

function hasColumn(headers: string[], aliases: string[]) {
  return aliases.some((alias) => headers.includes(normaliseHeader(alias)));
}

function cut(value: string | null, max: number) {
  return value ? value.slice(0, max) : null;
}

/** Pipedrive ids are whole numbers; spreadsheet tools sometimes add ".0". */
function cleanId(value: string | null) {
  if (!value) return null;
  const match = /^(\d+)(?:\.0+)?$/.exec(value.replace(/,/g, ""));
  return match ? match[1]! : null;
}

function count(value: string | null) {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The first of several comma-separated values (Pipedrive joins multiple emails and phones). */
function firstOf(value: string | null) {
  if (!value) return null;
  return value.split(/[,;]/).map((part) => part.trim()).find(Boolean) ?? null;
}

const ORG_ID = ["Organization - ID", "ID", "Organization ID"];
const ORG_NAME = ["Organization - Name", "Name", "Organization name", "Organization"];
const ORG_INDUSTRY = ["Organization - Industry", "Industry"];
const ORG_COUNTRY = [
  "Organization - Address - Country",
  "Organization - Address - Country/region",
  "Address - Country",
  "Address - Country/region",
  "Country",
  "Country/region",
];
const ORG_OWNER = ["Organization - Owner", "Owner", "Organization owner"];
const ORG_WON = ["Organization - Won deals", "Won deals"];
const ORG_OPEN = ["Organization - Open deals", "Open deals"];

const PERSON_ID = ["Person - ID", "ID", "Person ID"];
const PERSON_NAME = ["Person - Name", "Name", "Person name", "Full name"];
const PERSON_ORG_ID = ["Organization - ID", "Person - Organization ID", "Organization ID"];
const PERSON_ORG_NAME = ["Person - Organization", "Organization", "Organization - Name", "Organization name"];
const PERSON_ROLE = ["Person - Job title", "Job title", "Title", "Role"];
const PERSON_EMAIL = ["Person - Email - Work", "Person - Email", "Email - Work", "Email", "Person - Email - Other", "Email - Other", "Person - Email - Home", "Email - Home"];
const PERSON_PHONE = ["Person - Phone - Work", "Person - Phone", "Phone - Work", "Phone", "Person - Phone - Mobile", "Phone - Mobile", "Person - Phone - Other", "Phone - Other"];

const DEAL_ID = ["Deal - ID", "ID", "Deal ID"];
const DEAL_TITLE = ["Deal - Title", "Title", "Deal title", "Deal name", "Name"];
const DEAL_ORG_ID = ["Organization - ID", "Deal - Organization ID", "Organization ID"];
const DEAL_ORG_NAME = ["Deal - Organization", "Organization", "Organization - Name", "Organization name"];
const DEAL_VALUE = ["Deal - Value", "Value"];
const DEAL_CURRENCY = ["Deal - Currency of Value", "Deal - Currency", "Currency of Value", "Currency"];
const DEAL_STAGE = ["Deal - Stage", "Stage"];
const DEAL_STATUS = ["Deal - Status", "Status"];
const DEAL_CLOSE = ["Deal - Expected close date", "Expected close date"];
const DEAL_OWNER = ["Deal - Owner", "Owner"];
const DEAL_CONTACT = ["Deal - Contact person", "Contact person", "Person - Name"];

const ACTIVITY_ID = ["Activity - ID", "ID", "Activity ID"];
const ACTIVITY_SUBJECT = ["Activity - Subject", "Subject"];
const ACTIVITY_TYPE = ["Activity - Type", "Type"];
const ACTIVITY_DUE = ["Activity - Due date", "Due date", "Activity - Date", "Date"];
const ACTIVITY_DONE = ["Activity - Done", "Done", "Activity - Status", "Status"];
const ACTIVITY_NOTE = ["Activity - Note", "Note", "Notes"];
const ACTIVITY_DEAL_ID = ["Deal - ID", "Activity - Deal ID", "Deal ID"];
const ACTIVITY_DEAL_TITLE = ["Activity - Deal", "Deal", "Deal - Title"];
const ACTIVITY_ORG_NAME = ["Activity - Organization", "Organization", "Organization - Name"];

function requireColumns(file: string, headers: string[], required: Array<[string, string[]]>) {
  if (headers.length === 0) throw new PipedriveExportError(`The ${file} file is empty.`);
  const missing = required.filter(([, aliases]) => !hasColumn(headers, aliases)).map(([label]) => label);
  if (missing.length > 0) {
    throw new PipedriveExportError(
      `The ${file} file has no ${missing.join(" or ")} column. In Pipedrive, add the column to the list view and export again.`,
    );
  }
}

export interface ExportOrganisation extends MappedPipedriveOrganisation {
  wonDeals: number;
  openDeals: number;
}

export interface ExportContact extends MappedPipedriveContact {
  organisationName: string | null;
}

export interface ExportDeal {
  externalId: string;
  title: string;
  organisationExternalId: string | null;
  organisationName: string | null;
  value: number | null;
  currency: string | null;
  stageName: string | null;
  status: "open" | "won" | "lost" | "deleted" | null;
  expectedCloseDate: string | null;
  owner: string | null;
  contactName: string | null;
}

export interface ExportActivity {
  externalId: string | null;
  subject: string;
  type: string | null;
  dueDate: string | null;
  done: boolean;
  note: string | null;
  dealExternalId: string | null;
  dealTitle: string | null;
  organisationName: string | null;
}

export interface ParsedRows<T> {
  records: T[];
  /** Rows with no id or no name, which cannot be imported. */
  skipped: number;
}

export function readOrganisationsExport(input: string): ParsedRows<ExportOrganisation> {
  const { headers, rows } = csvRecords(input);
  requireColumns("organisations", headers, [["ID", ORG_ID], ["Name", ORG_NAME]]);
  const records: ExportOrganisation[] = [];
  let skipped = 0;
  for (const row of rows) {
    const externalId = cleanId(row(ORG_ID));
    const name = cut(row(ORG_NAME), 300);
    if (!externalId || !name) {
      skipped += 1;
      continue;
    }
    const wonDeals = count(row(ORG_WON));
    const openDeals = count(row(ORG_OPEN));
    records.push({
      externalId,
      name,
      industry: cut(row(ORG_INDUSTRY), 200),
      country: cut(row(ORG_COUNTRY), 120),
      countryOwner: cut(row(ORG_OWNER), 200),
      status: wonDeals > 0 ? "client" : openDeals > 0 ? "prospect" : "target",
      wonDeals,
      openDeals,
    });
  }
  return { records, skipped };
}

export function readPeopleExport(input: string): ParsedRows<ExportContact> {
  const { headers, rows } = csvRecords(input);
  requireColumns("people", headers, [["ID", PERSON_ID], ["Name", PERSON_NAME]]);
  const records: ExportContact[] = [];
  let skipped = 0;
  for (const row of rows) {
    const externalId = cleanId(row(PERSON_ID));
    const name = cut(row(PERSON_NAME), 300);
    if (!externalId || !name) {
      skipped += 1;
      continue;
    }
    records.push({
      externalId,
      organisationExternalId: cleanId(row(PERSON_ORG_ID)),
      organisationName: cut(row(PERSON_ORG_NAME), 300),
      name,
      role: cut(row(PERSON_ROLE), 200),
      email: cut(firstOf(row(PERSON_EMAIL)), 320),
      phone: cut(firstOf(row(PERSON_PHONE)), 80),
    });
  }
  return { records, skipped };
}

function dealStatus(value: string | null): ExportDeal["status"] {
  const lowered = value?.toLowerCase() ?? "";
  if (lowered === "open" || lowered === "won" || lowered === "lost" || lowered === "deleted") return lowered;
  return null;
}

/** Amounts as exported ("12,500", "12500.00", "£12,500"); null when not a number. */
function amount(value: string | null) {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) && /\d/.test(value) ? parsed : null;
}

export function readDealsExport(input: string): ParsedRows<ExportDeal> {
  const { headers, rows } = csvRecords(input);
  requireColumns("deals", headers, [["ID", DEAL_ID], ["Title", DEAL_TITLE]]);
  const records: ExportDeal[] = [];
  let skipped = 0;
  for (const row of rows) {
    const externalId = cleanId(row(DEAL_ID));
    const title = cut(row(DEAL_TITLE), 300);
    if (!externalId || !title) {
      skipped += 1;
      continue;
    }
    records.push({
      externalId,
      title,
      organisationExternalId: cleanId(row(DEAL_ORG_ID)),
      organisationName: cut(row(DEAL_ORG_NAME), 300),
      value: amount(row(DEAL_VALUE)),
      currency: cut(row(DEAL_CURRENCY), 10),
      stageName: cut(row(DEAL_STAGE), 200),
      status: dealStatus(row(DEAL_STATUS)),
      expectedCloseDate: cut(row(DEAL_CLOSE), 40),
      owner: cut(row(DEAL_OWNER), 200),
      contactName: cut(row(DEAL_CONTACT), 300),
    });
  }
  return { records, skipped };
}

function done(value: string | null) {
  const lowered = value?.toLowerCase() ?? "";
  return ["done", "yes", "true", "1", "completed"].includes(lowered);
}

export function readActivitiesExport(input: string): ParsedRows<ExportActivity> {
  const { headers, rows } = csvRecords(input);
  requireColumns("activities", headers, [["Subject", ACTIVITY_SUBJECT]]);
  const records: ExportActivity[] = [];
  let skipped = 0;
  for (const row of rows) {
    const subject = cut(row(ACTIVITY_SUBJECT), 300);
    if (!subject) {
      skipped += 1;
      continue;
    }
    records.push({
      externalId: cleanId(row(ACTIVITY_ID)),
      subject,
      type: cut(row(ACTIVITY_TYPE), 80),
      dueDate: cut(row(ACTIVITY_DUE), 40),
      done: done(row(ACTIVITY_DONE)),
      note: cut(row(ACTIVITY_NOTE), 2000),
      dealExternalId: cleanId(row(ACTIVITY_DEAL_ID)),
      dealTitle: cut(row(ACTIVITY_DEAL_TITLE), 300),
      organisationName: cut(row(ACTIVITY_ORG_NAME), 300),
    });
  }
  return { records, skipped };
}
