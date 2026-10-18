import { describe, expect, it, vi } from "vitest";
import { buildBatchPayload, ORGANISATION_ERROR_KEY, plainBatchError, validateDraftRows } from "./Pipelines";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "GRE" } }),
}));

const titleField = { key: "title", label: "Title", type: "text", required: true } as never;

describe("add items: organisation rule (GRE-1478, every pipeline since GRE-1538)", () => {
  it("asks for an organisation on every item", () => {
    const rows = [{ id: "r1", expanded: true, values: { title: "Acme" } }];

    expect(validateDraftRows(rows, [titleField])).toEqual({
      r1: { [ORGANISATION_ERROR_KEY]: "Pick or create an organisation." },
    });
    expect(validateDraftRows([{ ...rows[0]!, organisationId: "org-1" }], [titleField])).toEqual({});
  });

  it("sends the organisation with the item", () => {
    const payload = buildBatchPayload(
      [
        { id: "r1", expanded: true, values: { title: "Acme" }, organisationId: "org-1" },
        { id: "r2", expanded: true, values: { title: "Fix login" } },
      ],
      [titleField],
    );

    expect(payload).toEqual([
      { title: "Acme", fields: {}, organisationId: "org-1" },
      { title: "Fix login", fields: {} },
    ]);
  });

  it("explains the server's organisation errors in plain words", () => {
    const error = (code: string) => ({ ok: false as const, caseKey: null, error: { details: { code } } });

    expect(plainBatchError(error("organisation_required"))).toBe("Pick or create an organisation for this item.");
    expect(plainBatchError(error("organisation_archived"))).toBe("This organisation is archived. Pick another one.");
  });
});
