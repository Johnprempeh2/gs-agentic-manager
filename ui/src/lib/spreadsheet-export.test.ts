import { describe, expect, it } from "vitest";
import type { OrganisationListItem, WeeklyReport } from "@greatstone/shared";
import { emptyOrganisationCrmFields } from "@/fixtures/organisationCrmFields";
import { readZipTextFiles } from "./zip-text";
import {
  clientsSheet,
  columnName,
  exportFileName,
  sheetToCsv,
  sheetsToXlsx,
  weeklyNumbersSheet,
} from "./spreadsheet-export";

const kente: OrganisationListItem = {
  id: "org-1",
  companyId: "company-1",
  name: "Kente Logistics",
  website: "https://kente.example.com",
  industry: "Logistics",
  country: "Ghana",
  countryOwner: "Ben",
  status: "client",
  notes: "=SUM(A1) is not a formula here\nSecond line",
  ...emptyOrganisationCrmFields,
  source: "notion",
  externalId: null,
  archivedAt: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-15T09:00:00.000Z",
  keyContacts: [{ id: "c1", name: "Ama Mensah", role: "COO", email: "ama@kente.example.com", phone: null }],
  contactCount: 3,
  pipelines: [],
};

const report: WeeklyReport = {
  companyId: "company-1",
  companyName: "Greatstone",
  generatedAt: "2026-10-16T05:00:00.000Z",
  since: "2026-10-09T05:00:00.000Z",
  finished: { count: 12, agents: [{ agentId: "a1", name: "Everest", finished: 9, items: [] }] },
  stuck: { count: 2, items: [] },
  pipeline: { added: 3, moved: 5, won: 1, lost: 0, moves: [] },
  needsYou: { count: 4, items: [] },
  costs: { totalCents: 12345, agents: [{ agentId: "a1", name: "Everest", cents: 12345 }] },
};

describe("spreadsheet export", () => {
  it("writes clients as CSV with a byte order mark, quoted lines and formulas defused", () => {
    const csv = sheetToCsv(clientsSheet([kente]));
    expect(csv.startsWith("﻿Name,Stage,")).toBe(true);
    expect(csv).toContain("Kente Logistics,Client,Logistics,Ghana,Ben,https://kente.example.com,Ama Mensah (COO),ama@kente.example.com,3,notion,2026-10-01,2026-10-15,");
    expect(csv).toContain(`"'=SUM(A1) is not a formula here\nSecond line"`);
  });

  it("turns the This week report into measures with money in dollars", () => {
    const sheet = weeklyNumbersSheet(report);
    expect(sheet.rows).toContainEqual(["Tasks finished", 12]);
    expect(sheet.rows).toContainEqual(["Agent spend (USD)", 123.45]);
    expect(sheet.rows).toContainEqual(["Tasks finished: Everest", 9]);
    expect(sheet.rows[0]).toEqual(["Week from", "2026-10-09"]);
  });

  it("names columns past Z", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("builds an Excel workbook with one tab per sheet, numbers as numbers and text escaped", async () => {
    const bytes = sheetsToXlsx([clientsSheet([kente]), weeklyNumbersSheet(report), { name: "Clients", headers: ["A"], rows: [["<b>&"]] }]);
    const files = await readZipTextFiles(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, () => true);
    const byName = new Map(files.map((file) => [file.path, file.text]));
    expect([...byName.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet3.xml",
    ]);
    expect(byName.get("xl/workbook.xml")).toContain('<sheet name="Clients" sheetId="1"');
    expect(byName.get("xl/workbook.xml")).toContain('<sheet name="This week" sheetId="2"');
    expect(byName.get("xl/workbook.xml")).toContain('<sheet name="Clients 2" sheetId="3"');
    expect(byName.get("xl/worksheets/sheet1.xml")).toContain('<c r="I2"><v>3</v></c>');
    expect(byName.get("xl/worksheets/sheet1.xml")).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>');
    expect(byName.get("xl/worksheets/sheet2.xml")).toContain("<v>123.45</v>");
    expect(byName.get("xl/worksheets/sheet3.xml")).toContain("&lt;b&gt;&amp;");
  });

  it("names files after the company prefix and the day", () => {
    expect(exportFileName("GRE", "clients", "2026-10-16", "xlsx")).toBe("gre-clients-2026-10-16.xlsx");
    expect(exportFileName("", "tasks", "2026-10-16", "csv")).toBe("tasks-2026-10-16.csv");
  });
});
