import { describe, expect, it } from "vitest";
import { checkPipelineFieldValue, isEmptyPipelineFieldValue } from "./pipeline-fields.js";
import { createPipelineFieldSchema, updatePipelineFieldSchema } from "./validators/pipeline-fields.js";

describe("checkPipelineFieldValue", () => {
  const ok = { ok: true };
  const rule = (type: Parameters<typeof checkPipelineFieldValue>[0]["type"], options: string[] = []) => ({ type, options });

  it("accepts values of the right type", () => {
    expect(checkPipelineFieldValue(rule("text"), "Acme")).toEqual(ok);
    expect(checkPipelineFieldValue(rule("long_text"), "a".repeat(5_000))).toEqual(ok);
    expect(checkPipelineFieldValue(rule("number"), 1200.5)).toEqual(ok);
    expect(checkPipelineFieldValue(rule("boolean"), false)).toEqual(ok);
    expect(checkPipelineFieldValue(rule("date"), "2026-02-28")).toEqual(ok);
    expect(checkPipelineFieldValue(rule("select", ["Hot", "Cold"]), "Hot")).toEqual(ok);
    expect(checkPipelineFieldValue(rule("multi_select", ["A", "B"]), ["B", "A"])).toEqual(ok);
    expect(checkPipelineFieldValue(rule("email"), "jo@example.com")).toEqual(ok);
    expect(checkPipelineFieldValue(rule("phone"), "+44 (0)20 7946-0000")).toEqual(ok);
    expect(checkPipelineFieldValue(rule("url"), "https://example.com/a")).toEqual(ok);
  });

  it("rejects values of the wrong type", () => {
    expect(checkPipelineFieldValue(rule("text"), 12).ok).toBe(false);
    expect(checkPipelineFieldValue(rule("text"), "a".repeat(501)).ok).toBe(false);
    expect(checkPipelineFieldValue(rule("number"), "12").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("number"), Number.NaN).ok).toBe(false);
    expect(checkPipelineFieldValue(rule("boolean"), "true").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("date"), "2026-02-30").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("date"), "28/02/2026").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("select", ["Hot"]), "Warm").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("multi_select", ["A"]), "A").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("multi_select", ["A", "B"]), ["A", "C"]).ok).toBe(false);
    expect(checkPipelineFieldValue(rule("multi_select", ["A"]), ["A", "A"]).ok).toBe(false);
    expect(checkPipelineFieldValue(rule("email"), "not-an-email").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("phone"), "call me").ok).toBe(false);
    expect(checkPipelineFieldValue(rule("url"), "javascript:alert(1)").ok).toBe(false);
  });

  it("treats null, blank text and empty lists as empty", () => {
    expect(isEmptyPipelineFieldValue(null)).toBe(true);
    expect(isEmptyPipelineFieldValue(undefined)).toBe(true);
    expect(isEmptyPipelineFieldValue("  ")).toBe(true);
    expect(isEmptyPipelineFieldValue([])).toBe(true);
    expect(isEmptyPipelineFieldValue(0)).toBe(false);
    expect(isEmptyPipelineFieldValue(false)).toBe(false);
  });
});

describe("pipeline field validators", () => {
  it("needs choices for choice fields and none for others", () => {
    expect(createPipelineFieldSchema.safeParse({ key: "tier", label: "Tier", type: "select" }).success).toBe(false);
    expect(createPipelineFieldSchema.safeParse({ key: "tier", label: "Tier", type: "select", options: ["Gold"] }).success).toBe(true);
    expect(createPipelineFieldSchema.safeParse({ key: "notes", label: "Notes", type: "text", options: ["x"] }).success).toBe(false);
  });

  it("checks the key shape so it works as fields.<key> in the CRM field map", () => {
    expect(createPipelineFieldSchema.safeParse({ key: "dealValue", label: "Value", type: "number" }).success).toBe(true);
    expect(createPipelineFieldSchema.safeParse({ key: "deal-value", label: "Value", type: "number" }).success).toBe(false);
    expect(createPipelineFieldSchema.safeParse({ key: "1value", label: "Value", type: "number" }).success).toBe(false);
  });

  it("rejects repeated choices", () => {
    expect(createPipelineFieldSchema.safeParse({ key: "tier", label: "Tier", type: "select", options: ["A", "A"] }).success).toBe(false);
  });

  it("does not let key or type change on edit", () => {
    expect(updatePipelineFieldSchema.safeParse({ label: "New" }).success).toBe(true);
    expect(updatePipelineFieldSchema.safeParse({ type: "number" }).success).toBe(false);
    expect(updatePipelineFieldSchema.safeParse({ key: "other" }).success).toBe(false);
  });
});
