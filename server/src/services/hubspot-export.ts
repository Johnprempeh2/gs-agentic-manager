// Reads the CSV files HubSpot exports (companies, contacts, deals) into the
// same plain records the Pipedrive export import uses, so one import path
// writes both. HubSpot names export columns after property labels ("Company
// name", "Record ID", "Associated Company"); each field accepts a few spellings.
import {
  PipedriveExportError,
  cleanId,
  csvRecords,
  cut,
  firstOf,
  requireColumns,
  type ExportContact,
  type ExportDeal,
  type ExportOrganisation,
  type ParsedRows,
} from "./pipedrive-export.js";

const COMPANY_ID = ["Record ID", "Company ID", "ID", "hs_object_id"];
const CONTACT_ID = ["Record ID", "Contact ID", "ID", "hs_object_id"];
const DEAL_ID = ["Record ID", "Deal ID", "ID", "hs_object_id"];
const COMPANY_NAME = ["Company name", "Name", "Company"];
const COMPANY_INDUSTRY = ["Industry"];
const COMPANY_COUNTRY = ["Country/Region", "Country", "Country/region"];
const COMPANY_OWNER = ["Company owner", "Owner", "HubSpot owner"];
const COMPANY_LIFECYCLE = ["Lifecycle Stage", "Lifecycle stage"];

const CONTACT_FIRST = ["First Name", "First name", "Firstname"];
const CONTACT_LAST = ["Last Name", "Last name", "Lastname"];
const CONTACT_NAME = ["Name", "Full name", "Contact name"];
const CONTACT_EMAIL = ["Email", "Email address"];
const CONTACT_PHONE = ["Phone Number", "Phone number", "Mobile Phone Number", "Phone"];
const CONTACT_ROLE = ["Job Title", "Job title"];
const ASSOCIATED_COMPANY_ID = [
  "Associated Company IDs (Primary)",
  "Associated Company ID (Primary)",
  "Associated Company IDs",
  "Associated Company ID",
  "Primary Associated Company ID",
  "Company ID",
];
const ASSOCIATED_COMPANY_NAME = [
  "Associated Company (Primary)",
  "Associated Company",
  "Associated Companies",
  "Company Name",
  "Company name",
];

const DEAL_NAME = ["Deal Name", "Deal name", "Name"];
const DEAL_STAGE = ["Deal Stage", "Deal stage", "Stage"];
const DEAL_AMOUNT = ["Amount", "Amount in company currency", "Deal amount"];
const DEAL_CURRENCY = ["Currency", "Deal currency code", "Deal Currency Code"];
const DEAL_CLOSE = ["Close Date", "Close date", "Expected close date"];
const DEAL_OWNER = ["Deal owner", "Deal Owner", "Owner", "HubSpot owner"];
const DEAL_CONTACT = ["Associated Contact", "Associated Contact (Primary)", "Associated Contacts"];

function amount(value: string | null) {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) && /\d/.test(value) ? parsed : null;
}

/** HubSpot's default stages end in "Closed won" and "Closed lost"; anything else is open. */
export function hubspotDealStatus(stage: string | null): ExportDeal["status"] {
  const lowered = stage?.toLowerCase().replace(/[\s_-]+/g, " ").trim() ?? "";
  if (/closed ?won|\bwon\b/.test(lowered)) return "won";
  if (/closed ?lost|\blost\b/.test(lowered)) return "lost";
  return "open";
}

export function readHubspotCompaniesExport(input: string): ParsedRows<ExportOrganisation> {
  const { headers, rows } = csvRecords(input);
  requireColumns("companies", headers, [["Record ID", COMPANY_ID], ["Company name", COMPANY_NAME]], "HubSpot");
  const records: ExportOrganisation[] = [];
  let skipped = 0;
  for (const row of rows) {
    const externalId = cleanId(row(COMPANY_ID));
    const name = cut(row(COMPANY_NAME), 300);
    if (!externalId || !name) {
      skipped += 1;
      continue;
    }
    const lifecycle = row(COMPANY_LIFECYCLE)?.toLowerCase() ?? "";
    const client = lifecycle === "customer" || lifecycle === "evangelist";
    const prospect = ["opportunity", "salesqualifiedlead", "sales qualified lead"].includes(lifecycle);
    records.push({
      externalId,
      name,
      industry: cut(row(COMPANY_INDUSTRY), 200),
      country: cut(row(COMPANY_COUNTRY), 120),
      countryOwner: cut(row(COMPANY_OWNER), 200),
      status: client ? "client" : prospect ? "prospect" : "target",
      wonDeals: client ? 1 : 0,
      openDeals: prospect ? 1 : 0,
    });
  }
  return { records, skipped };
}

export function readHubspotContactsExport(input: string): ParsedRows<ExportContact> {
  const { headers, rows } = csvRecords(input);
  const hasNameParts = [CONTACT_FIRST, CONTACT_LAST, CONTACT_NAME];
  requireColumns("contacts", headers, [["Record ID", CONTACT_ID], ["First Name", hasNameParts.flat()]], "HubSpot");
  const records: ExportContact[] = [];
  let skipped = 0;
  for (const row of rows) {
    const externalId = cleanId(row(CONTACT_ID));
    const joined = [row(CONTACT_FIRST), row(CONTACT_LAST)].filter(Boolean).join(" ");
    const email = cut(firstOf(row(CONTACT_EMAIL)), 320);
    const name = cut(joined || row(CONTACT_NAME) || email, 300);
    if (!externalId || !name) {
      skipped += 1;
      continue;
    }
    records.push({
      externalId,
      organisationExternalId: cleanId(firstOf(row(ASSOCIATED_COMPANY_ID))),
      organisationName: cut(firstOf(row(ASSOCIATED_COMPANY_NAME)), 300),
      name,
      role: cut(row(CONTACT_ROLE), 200),
      email,
      phone: cut(firstOf(row(CONTACT_PHONE)), 80),
    });
  }
  return { records, skipped };
}

export function readHubspotDealsExport(input: string): ParsedRows<ExportDeal> {
  const { headers, rows } = csvRecords(input);
  requireColumns("deals", headers, [["Record ID", DEAL_ID], ["Deal Name", DEAL_NAME]], "HubSpot");
  const records: ExportDeal[] = [];
  let skipped = 0;
  for (const row of rows) {
    const externalId = cleanId(row(DEAL_ID));
    const title = cut(row(DEAL_NAME), 300);
    if (!externalId || !title) {
      skipped += 1;
      continue;
    }
    const stageName = cut(row(DEAL_STAGE), 200);
    records.push({
      externalId,
      title,
      organisationExternalId: cleanId(firstOf(row(ASSOCIATED_COMPANY_ID))),
      organisationName: cut(firstOf(row(ASSOCIATED_COMPANY_NAME)), 300),
      value: amount(row(DEAL_AMOUNT)),
      currency: cut(row(DEAL_CURRENCY), 10),
      stageName,
      status: hubspotDealStatus(stageName),
      expectedCloseDate: cut(row(DEAL_CLOSE), 40),
      owner: cut(row(DEAL_OWNER), 200),
      contactName: cut(firstOf(row(DEAL_CONTACT)), 300),
    });
  }
  return { records, skipped };
}

export { PipedriveExportError as CrmExportError };
