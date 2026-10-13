// Form state for the global CRM fields on an organisation (GRE-1539). The
// form holds text; this turns it into the API body and back.
import type {
  Organisation,
  OrganisationOwnershipType,
  OrganisationSizeBand,
  UpdateOrganisation,
} from "@greatstone/shared";
import { assigneeValueFromSelection, parseAssigneeValue } from "./assignees";

export const CRM_TEXT_FIELDS = [
  "legalName",
  "domain",
  "phone",
  "email",
  "addressStreet",
  "addressCity",
  "addressRegion",
  "addressPostalCode",
  "linkedinUrl",
  "segment",
  "description",
  "registrationNumber",
  "taxId",
  "annualRevenueCurrency",
] as const;
export type CrmTextField = (typeof CRM_TEXT_FIELDS)[number];

export type CrmForm = Record<CrmTextField, string> & {
  employeeCount: string;
  annualRevenue: string;
  sizeBand: OrganisationSizeBand | "";
  ownershipType: OrganisationOwnershipType | "";
  parentOrganisationId: string;
  /** "user:<id>", "agent:<id>" or "" (the same values as the task assignee picker). */
  accountOwner: string;
  /** Comma-separated. */
  tags: string;
};

export function crmFormFromOrganisation(organisation: Organisation | null): CrmForm {
  const text = Object.fromEntries(
    CRM_TEXT_FIELDS.map((key) => [key, organisation?.[key] ?? ""]),
  ) as Record<CrmTextField, string>;
  return {
    ...text,
    employeeCount: organisation?.employeeCount == null ? "" : String(organisation.employeeCount),
    annualRevenue: organisation?.annualRevenue == null ? "" : String(organisation.annualRevenue),
    sizeBand: organisation?.sizeBand ?? "",
    ownershipType: organisation?.ownershipType ?? "",
    parentOrganisationId: organisation?.parentOrganisationId ?? "",
    accountOwner: assigneeValueFromSelection({
      assigneeUserId: organisation?.accountOwnerUserId ?? null,
      assigneeAgentId: organisation?.accountOwnerAgentId ?? null,
    }),
    tags: (organisation?.tags ?? []).join(", "),
  };
}

/** "1,200" and "1 200" read as 1200; blank is null; anything else is NaN. */
function parseNumber(value: string): number | null {
  const cleaned = value.replace(/[\s,]/g, "");
  return cleaned ? Number(cleaned) : null;
}

export type CrmPayload = Required<
  Pick<
    UpdateOrganisation,
    | CrmTextField
    | "employeeCount"
    | "annualRevenue"
    | "sizeBand"
    | "ownershipType"
    | "parentOrganisationId"
    | "accountOwnerUserId"
    | "accountOwnerAgentId"
    | "tags"
  >
>;

/** The API body for the CRM fields, or the first problem to show the user. */
export function crmPayloadFromForm(form: CrmForm): { payload: CrmPayload } | { error: string } {
  const employeeCount = parseNumber(form.employeeCount);
  if (employeeCount !== null && (!Number.isInteger(employeeCount) || employeeCount < 0)) {
    return { error: "Employees must be a whole number." };
  }
  const annualRevenue = parseNumber(form.annualRevenue);
  if (annualRevenue !== null && (!Number.isFinite(annualRevenue) || annualRevenue < 0)) {
    return { error: "Annual revenue must be a number." };
  }
  if (annualRevenue !== null && !form.annualRevenueCurrency.trim()) {
    return { error: "Add the currency of the annual revenue, such as GBP." };
  }
  const owner = parseAssigneeValue(form.accountOwner);
  const text = Object.fromEntries(
    CRM_TEXT_FIELDS.map((key) => [key, form[key].trim() || null]),
  ) as Record<CrmTextField, string | null>;
  return {
    payload: {
      ...text,
      employeeCount,
      annualRevenue,
      sizeBand: form.sizeBand || null,
      ownershipType: form.ownershipType || null,
      parentOrganisationId: form.parentOrganisationId || null,
      accountOwnerUserId: owner.assigneeUserId,
      accountOwnerAgentId: owner.assigneeAgentId,
      tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    },
  };
}
