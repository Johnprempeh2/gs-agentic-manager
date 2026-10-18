import { describe, expect, it } from "vitest";
import type { Organisation } from "@greatstone/shared";
import { emptyOrganisationCrmFields } from "@/fixtures/organisationCrmFields";
import { crmFormFromOrganisation, crmPayloadFromForm } from "./organisation-crm-form";

const base = {
  id: "org-1",
  companyId: "company-1",
  name: "Acme",
  website: null,
  industry: null,
  country: null,
  countryOwner: null,
  status: "target",
  notes: null,
  source: "manual",
  externalId: null,
  archivedAt: null,
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z",
  ...emptyOrganisationCrmFields,
} satisfies Organisation;

describe("organisation CRM form (GRE-1539)", () => {
  it("starts empty for a new organisation and sends nulls", () => {
    const form = crmFormFromOrganisation(null);
    expect(form.legalName).toBe("");
    expect(form.accountOwner).toBe("");
    const result = crmPayloadFromForm(form);
    expect(result).toEqual({
      payload: expect.objectContaining({
        legalName: null,
        employeeCount: null,
        annualRevenue: null,
        sizeBand: null,
        parentOrganisationId: null,
        accountOwnerUserId: null,
        accountOwnerAgentId: null,
        tags: [],
      }),
    });
  });

  it("round-trips an organisation's values", () => {
    const organisation: Organisation = {
      ...base,
      legalName: "Acme Ltd",
      employeeCount: 12,
      annualRevenue: 99.5,
      annualRevenueCurrency: "EUR",
      accountOwnerUserId: "user-1",
      tags: ["a", "b"],
      sizeBand: "11-50",
    };
    const result = crmPayloadFromForm(crmFormFromOrganisation(organisation));
    expect(result).toEqual({
      payload: expect.objectContaining({
        legalName: "Acme Ltd",
        employeeCount: 12,
        annualRevenue: 99.5,
        annualRevenueCurrency: "EUR",
        accountOwnerUserId: "user-1",
        accountOwnerAgentId: null,
        tags: ["a", "b"],
        sizeBand: "11-50",
      }),
    });
  });

  it("reads numbers with separators and an agent as owner", () => {
    const form = { ...crmFormFromOrganisation(null), employeeCount: "1 200", annualRevenue: "1,500.25", annualRevenueCurrency: "gbp", accountOwner: "agent:a-1" };
    const result = crmPayloadFromForm(form);
    expect(result).toEqual({
      payload: expect.objectContaining({ employeeCount: 1200, annualRevenue: 1500.25, accountOwnerAgentId: "a-1", accountOwnerUserId: null }),
    });
  });

  it("explains bad numbers and a revenue with no currency", () => {
    const empty = crmFormFromOrganisation(null);
    expect(crmPayloadFromForm({ ...empty, employeeCount: "12.5" })).toEqual({ error: "Employees must be a whole number." });
    expect(crmPayloadFromForm({ ...empty, employeeCount: "many" })).toEqual({ error: "Employees must be a whole number." });
    expect(crmPayloadFromForm({ ...empty, annualRevenue: "lots", annualRevenueCurrency: "GBP" })).toEqual({ error: "Annual revenue must be a number." });
    expect(crmPayloadFromForm({ ...empty, annualRevenue: "100" })).toEqual({ error: "Add the currency of the annual revenue, such as GBP." });
  });
});
