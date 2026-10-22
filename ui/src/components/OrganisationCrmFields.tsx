// Global CRM fields on an organisation (GRE-1539): the form sections used by
// the add/edit dialog, and the read-only rows on the company page.
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ORGANISATION_OWNERSHIP_TYPES,
  ORGANISATION_OWNERSHIP_TYPE_LABELS,
  ORGANISATION_SIZE_BANDS,
  ORGANISATION_SIZE_BAND_LABELS,
  type Organisation,
} from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { organisationsApi } from "@/api/organisations";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { assigneeValueFromSelection } from "@/lib/assignees";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import type { CrmForm } from "@/lib/organisation-crm-form";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

/** People and agents of the company, for the account owner field and its label. */
export function useAccountOwnerOptions(companyId: string) {
  const users = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: Boolean(companyId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  return useMemo(() => {
    const userLabels = buildCompanyUserLabelMap(users.data?.users);
    const people = [...userLabels.entries()].map(([id, label]) => ({ value: `user:${id}`, label }));
    const agentOptions = (agents.data ?? [])
      .filter((agent) => agent.status !== "terminated")
      .map((agent) => ({ value: `agent:${agent.id}`, label: agent.name }));
    const labels = new Map([...people, ...agentOptions].map((option) => [option.value, option.label]));
    return { people, agents: agentOptions, labelFor: (value: string) => (value ? labels.get(value) ?? null : null) };
  }, [users.data, agents.data]);
}

export function accountOwnerValue(organisation: Pick<Organisation, "accountOwnerUserId" | "accountOwnerAgentId">) {
  return assigneeValueFromSelection({
    assigneeUserId: organisation.accountOwnerUserId,
    assigneeAgentId: organisation.accountOwnerAgentId,
  });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2 border-t border-border pt-3">
      <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/** Form sections for the CRM fields. The dialog owns the state and the save. */
export function OrganisationCrmFieldsForm({
  companyId,
  organisationId,
  form,
  onChange,
}: {
  companyId: string;
  /** The organisation being edited, so it is not offered as its own parent. */
  organisationId: string | null;
  form: CrmForm;
  onChange: (patch: Partial<CrmForm>) => void;
}) {
  const owners = useAccountOwnerOptions(companyId);
  const organisations = useQuery({
    queryKey: queryKeys.organisations.list(companyId, {}),
    queryFn: () => organisationsApi.list(companyId),
  });
  const parents = (organisations.data ?? []).filter(
    (organisation) => organisation.id !== organisationId && (!organisation.archivedAt || organisation.id === form.parentOrganisationId),
  );

  const text = (key: keyof CrmForm, label: string, props: Partial<React.ComponentProps<typeof Input>> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`organisation-${key}`}>{label}</Label>
      <Input
        id={`organisation-${key}`}
        value={form[key]}
        onChange={(event) => onChange({ [key]: event.target.value })}
        {...props}
      />
    </div>
  );

  return (
    <>
      <Section title="Account">
        {text("legalName", "Legal name")}
        {text("segment", "Segment or tier", { placeholder: "e.g. Enterprise, Tier 1" })}
        <div className="space-y-1">
          <Label htmlFor="organisation-accountOwner">Account owner</Label>
          <NativeSelect
            id="organisation-accountOwner"
            value={form.accountOwner}
            onChange={(event) => onChange({ accountOwner: event.target.value })}
          >
            <option value="">No account owner</option>
            {owners.people.length > 0 ? (
              <optgroup label="People">
                {owners.people.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </optgroup>
            ) : null}
            {owners.agents.length > 0 ? (
              <optgroup label="Agents">
                {owners.agents.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </optgroup>
            ) : null}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="organisation-parentOrganisationId">Parent organisation</Label>
          <NativeSelect
            id="organisation-parentOrganisationId"
            value={form.parentOrganisationId}
            onChange={(event) => onChange({ parentOrganisationId: event.target.value })}
          >
            <option value="">No parent</option>
            {parents.map((organisation) => (
              <option key={organisation.id} value={organisation.id}>{organisation.name}</option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="organisation-ownershipType">Ownership</Label>
          <NativeSelect
            id="organisation-ownershipType"
            value={form.ownershipType}
            onChange={(event) => onChange({ ownershipType: event.target.value as CrmForm["ownershipType"] })}
          >
            <option value="">Not set</option>
            {ORGANISATION_OWNERSHIP_TYPES.map((value) => (
              <option key={value} value={value}>{ORGANISATION_OWNERSHIP_TYPE_LABELS[value]}</option>
            ))}
          </NativeSelect>
        </div>
        {text("tags", "Tags", { placeholder: "Separate with commas" })}
      </Section>

      <Section title="Contact details">
        {text("domain", "Domain", { placeholder: "example.com" })}
        {text("linkedinUrl", "LinkedIn", { placeholder: "linkedin.com/company/…" })}
        {text("phone", "Phone", { type: "tel" })}
        {text("email", "General email", { type: "email" })}
      </Section>

      <Section title="Address">
        {text("addressStreet", "Street")}
        {text("addressCity", "City")}
        {text("addressRegion", "Region or state")}
        {text("addressPostalCode", "Postal code")}
      </Section>

      <Section title="Size and revenue">
        {text("employeeCount", "Employees", { inputMode: "numeric" })}
        <div className="space-y-1">
          <Label htmlFor="organisation-sizeBand">Size band</Label>
          <NativeSelect
            id="organisation-sizeBand"
            value={form.sizeBand}
            onChange={(event) => onChange({ sizeBand: event.target.value as CrmForm["sizeBand"] })}
          >
            <option value="">Not set</option>
            {ORGANISATION_SIZE_BANDS.map((value) => (
              <option key={value} value={value}>{ORGANISATION_SIZE_BAND_LABELS[value]}</option>
            ))}
          </NativeSelect>
        </div>
        {text("annualRevenue", "Annual revenue", { inputMode: "decimal" })}
        {text("annualRevenueCurrency", "Currency", { placeholder: "GBP", maxLength: 3, className: "uppercase" })}
      </Section>

      <Section title="Registration">
        {text("registrationNumber", "Registration number")}
        {text("taxId", "Tax ID")}
      </Section>

      <div className="space-y-1 border-t border-border pt-3">
        <Label htmlFor="organisation-description">Description</Label>
        <Textarea
          id="organisation-description"
          rows={3}
          value={form.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>
    </>
  );
}

const numberFormat = new Intl.NumberFormat("en-GB");

export function formatRevenue(organisation: Pick<Organisation, "annualRevenue" | "annualRevenueCurrency">) {
  if (organisation.annualRevenue === null) return null;
  if (!organisation.annualRevenueCurrency) return numberFormat.format(organisation.annualRevenue);
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: organisation.annualRevenueCurrency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    }).format(organisation.annualRevenue);
  } catch {
    return `${numberFormat.format(organisation.annualRevenue)} ${organisation.annualRevenueCurrency}`;
  }
}

/** "1,200 employees", else the band, else null. */
export function formatSize(organisation: Pick<Organisation, "employeeCount" | "sizeBand">) {
  if (organisation.employeeCount !== null) return `${numberFormat.format(organisation.employeeCount)} employees`;
  return organisation.sizeBand ? ORGANISATION_SIZE_BAND_LABELS[organisation.sizeBand] : null;
}

function externalHref(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** The CRM fields on the company page; fields that are not set are left out. */
export function OrganisationCrmInfo({ companyId, organisation }: { companyId: string; organisation: Organisation }) {
  const owners = useAccountOwnerOptions(companyId);
  const parent = useQuery({
    queryKey: queryKeys.organisations.detail(companyId, organisation.parentOrganisationId ?? ""),
    queryFn: () => organisationsApi.get(companyId, organisation.parentOrganisationId!),
    enabled: Boolean(organisation.parentOrganisationId),
  });
  const address = [
    organisation.addressStreet,
    organisation.addressCity,
    organisation.addressRegion,
    organisation.addressPostalCode,
  ].filter(Boolean).join(", ");
  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noreferrer" className="break-all hover:underline">{label}</a>
  );
  const rows: Array<[string, ReactNode | null]> = [
    ["Account owner", owners.labelFor(accountOwnerValue(organisation))],
    ["Legal name", organisation.legalName],
    ["Segment or tier", organisation.segment],
    [
      "Parent organisation",
      organisation.parentOrganisationId ? (
        <Link to={`/organisations/${organisation.parentOrganisationId}`} className="hover:underline">
          {parent.data?.name ?? "Open parent"}
        </Link>
      ) : null,
    ],
    ["Ownership", organisation.ownershipType ? ORGANISATION_OWNERSHIP_TYPE_LABELS[organisation.ownershipType] : null],
    ["Size", formatSize(organisation)],
    ["Annual revenue", formatRevenue(organisation)],
    ["Domain", organisation.domain ? link(externalHref(organisation.domain), organisation.domain) : null],
    ["LinkedIn", organisation.linkedinUrl ? link(externalHref(organisation.linkedinUrl), organisation.linkedinUrl) : null],
    ["Phone", organisation.phone ? <a href={`tel:${organisation.phone}`} className="hover:underline">{organisation.phone}</a> : null],
    [
      "General email",
      organisation.email ? <a href={`mailto:${organisation.email}`} className="break-all hover:underline">{organisation.email}</a> : null,
    ],
    ["Address", address || null],
    ["Registration number", organisation.registrationNumber],
    ["Tax ID", organisation.taxId],
  ];
  const shown = rows.filter((row): row is [string, ReactNode] => row[1] !== null && row[1] !== "");
  if (shown.length === 0 && organisation.tags.length === 0 && !organisation.description) return null;
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3" data-testid="organisation-crm-info">
      {shown.length > 0 ? (
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {shown.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {organisation.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1" aria-label="Tags">
          {organisation.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
        </div>
      ) : null}
      {organisation.description ? <p className="whitespace-pre-wrap text-sm">{organisation.description}</p> : null}
    </div>
  );
}
