import { describe, expect, it } from "vitest";
import {
  createCrmSyncBindingSchema,
  crmSyncConflictSchema,
  crmSyncEventSchema,
  crmSyncFieldMapSchema,
  crmSyncGsamFieldSchema,
  crmSyncRecordLinksSchema,
  listCrmSyncConflictsQuerySchema,
  resolveCrmSyncConflictSchema,
  updateCrmSyncBindingSchema,
} from "../index.js";

const connectionId = "11111111-1111-4111-8111-111111111111";
const pipelineId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const caseId = "44444444-4444-4444-8444-444444444444";
const contactId = "55555555-5555-4555-8555-555555555555";
const otherConnectionId = "66666666-6666-4666-8666-666666666666";

describe("CRM sync binding", () => {
  it("accepts a CRM pipeline binding and defaults to two-way with empty maps", () => {
    const parsed = createCrmSyncBindingSchema.parse({
      connectionId,
      providerKey: "hubspot",
      containerKind: "crm_pipeline",
      externalContainerId: "default",
      pipelineId,
    });
    expect(parsed).toMatchObject({ direction: "both", stageMap: [], fieldMap: [] });
  });

  it("accepts a Notion database binding with a stage map", () => {
    expect(createCrmSyncBindingSchema.safeParse({
      connectionId,
      providerKey: "notion",
      containerKind: "notion_database",
      externalContainerId: "db_123",
      pipelineId,
      stageMap: [{ externalStageId: "Lead", stageKey: "lead" }],
    }).success).toBe(true);
  });

  it("rejects unknown container kinds, extra keys and one external stage mapped twice", () => {
    const base = { connectionId, providerKey: "hubspot", containerKind: "crm_pipeline", externalContainerId: "p1", pipelineId };
    expect(createCrmSyncBindingSchema.safeParse({ ...base, containerKind: "spreadsheet" }).success).toBe(false);
    expect(createCrmSyncBindingSchema.safeParse({ ...base, apiKey: "secret" }).success).toBe(false);
    expect(createCrmSyncBindingSchema.safeParse({
      ...base,
      stageMap: [{ externalStageId: "s1", stageKey: "a" }, { externalStageId: "s1", stageKey: "b" }],
    }).success).toBe(false);
  });

  it("does not let an update re-point the binding or set the error status", () => {
    expect(updateCrmSyncBindingSchema.safeParse({ status: "paused" }).success).toBe(true);
    expect(updateCrmSyncBindingSchema.safeParse({ status: "error" }).success).toBe(false);
    expect(updateCrmSyncBindingSchema.safeParse({ pipelineId }).success).toBe(false);
  });
});

describe("CRM sync field map and owner", () => {
  it("accepts case and contact targets with one owner each", () => {
    expect(crmSyncFieldMapSchema.parse([
      { externalField: "dealname", gsamField: "title", owner: "crm" },
      { externalField: "notes", gsamField: "summary", owner: "gsam" },
      { externalField: "amount", gsamField: "fields.dealValue", owner: "shared" },
      { externalField: "email", gsamField: "contact.email", owner: "shared" },
    ])).toHaveLength(4);
  });

  it("rejects unknown targets and owners", () => {
    expect(crmSyncGsamFieldSchema.safeParse("stage").success).toBe(false);
    expect(crmSyncGsamFieldSchema.safeParse("contact.address").success).toBe(false);
    expect(crmSyncGsamFieldSchema.safeParse("fields.1bad").success).toBe(false);
    expect(crmSyncFieldMapSchema.safeParse([
      { externalField: "dealname", gsamField: "title", owner: "both" },
    ]).success).toBe(false);
  });

  it("rejects a field mapped twice on either side, so no field has two owners", () => {
    expect(crmSyncFieldMapSchema.safeParse([
      { externalField: "dealname", gsamField: "title", owner: "crm" },
      { externalField: "dealname", gsamField: "summary", owner: "gsam" },
    ]).success).toBe(false);
    expect(crmSyncFieldMapSchema.safeParse([
      { externalField: "dealname", gsamField: "title", owner: "crm" },
      { externalField: "name", gsamField: "title", owner: "gsam" },
    ]).success).toBe(false);
  });
});

describe("CRM sync external ids", () => {
  it("lets one contact hold several external ids, one per source", () => {
    const hubspot = { entityKind: "contact", entityId: contactId, connectionId, providerKey: "hubspot", externalId: "101" };
    const notion = { ...hubspot, connectionId: otherConnectionId, providerKey: "notion", externalId: "page_1" };
    expect(crmSyncRecordLinksSchema.safeParse([hubspot, notion]).success).toBe(true);
    expect(crmSyncRecordLinksSchema.safeParse([hubspot, { ...hubspot, externalId: "102" }]).success).toBe(false);
  });
});

describe("CRM sync event", () => {
  const base = { bindingId, direction: "inbound", entityKind: "case", entityId: caseId, externalId: "deal_9" };

  it("accepts an update with changed fields", () => {
    expect(crmSyncEventSchema.parse({
      ...base,
      action: "updated",
      changedFields: [{ gsamField: "fields.dealValue", from: 100, to: 250 }],
    })).toMatchObject({ conflictId: null, errorMessage: null });
  });

  it("requires an error message on failures and a conflict id on conflicts", () => {
    expect(crmSyncEventSchema.safeParse({ ...base, action: "failed" }).success).toBe(false);
    expect(crmSyncEventSchema.safeParse({ ...base, action: "failed", errorMessage: "CRM said 429" }).success).toBe(true);
    expect(crmSyncEventSchema.safeParse({ ...base, action: "conflict" }).success).toBe(false);
  });
});

describe("CRM sync conflict", () => {
  it("carries all three values and allows a missing last-synced value", () => {
    const conflict = {
      bindingId,
      entityKind: "case",
      entityId: caseId,
      externalId: "deal_9",
      gsamField: "fields.dealValue",
      externalField: "amount",
      lastSyncedValue: 100,
      crmValue: 200,
      gsamValue: 300,
    };
    expect(crmSyncConflictSchema.safeParse(conflict).success).toBe(true);
    const { lastSyncedValue: _ignored, ...firstSync } = conflict;
    expect(crmSyncConflictSchema.safeParse(firstSync).success).toBe(true);
    const { crmValue: _missing, ...noCrmValue } = conflict;
    expect(crmSyncConflictSchema.safeParse(noCrmValue).success).toBe(false);
  });

  it("resolves by keeping a side or a custom value", () => {
    expect(resolveCrmSyncConflictSchema.safeParse({ resolution: "keep_crm" }).success).toBe(true);
    expect(resolveCrmSyncConflictSchema.safeParse({ resolution: "custom", value: "Acme Ltd" }).success).toBe(true);
    expect(resolveCrmSyncConflictSchema.safeParse({ resolution: "custom" }).success).toBe(false);
    expect(resolveCrmSyncConflictSchema.safeParse({ resolution: "keep_gsam", value: "x" }).success).toBe(false);
  });

  it("lists open conflicts by default", () => {
    expect(listCrmSyncConflictsQuerySchema.parse({})).toMatchObject({ status: "open", limit: 50 });
    expect(listCrmSyncConflictsQuerySchema.parse({ limit: "10" }).limit).toBe(10);
  });
});
