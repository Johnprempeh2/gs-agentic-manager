import type { CommerceRow } from "@/api/website-commerce";
import { statusLabel, text } from "@/lib/commerce";
import type { CommerceFieldDef } from "@/lib/commerce-write";

// Commerce settings (GRE-4784, on the GRE-4782 bridge routes): order status, enquiries and leads, client companies,
// the client timeline, licence keys, customer tiers and portal receipts. People only, here as on the server and the
// site: a client email, a licence key, a client's tier, sharing a timeline item and deleting a lead.

const options = (values: readonly string[]) => values.map((value) => ({ value, label: statusLabel(value) }));

/** The statuses a person may set. `refunded` moves only with a refund; a cancelled order stays cancelled. */
export const ORDER_STATUSES = ["pending", "confirmed", "fulfilled", "cancelled"] as const;
export const ORDER_STATUS_FIELDS: CommerceFieldDef[] = [
  { name: "status", column: "status", label: "Status", kind: "select", required: true, options: options(ORDER_STATUSES),
    help: "A cancelled order cannot change again." },
];

/** An order whose status the site will not change (409). */
export function orderStatusLocked(order: CommerceRow): boolean {
  return ["cancelled", "refunded"].includes(text(order.status) ?? "");
}

/** What the licence-issued email answer means, for the person who sent it. */
export function licenceEmailMessage(email: string | undefined): { tone: "ok" | "warn"; text: string } {
  if (email === "sent") return { tone: "ok", text: "The website emailed the client. The email links to their account and holds no key." };
  if (email === "sending") return { tone: "ok", text: "This email was already sent for this click. Nothing more was sent." };
  if (email === "not_configured") return { tone: "warn", text: "The website has no email service set up, so nothing was sent." };
  return { tone: "warn", text: "The email service refused the email. Nothing was sent. Try again." };
}

export const ENQUIRY_STATUSES = ["new", "contacted", "closed"] as const;

/** `fd-` ids are front door leads (they can be deleted, by a person); `si-` are service enquiries. */
export const isFrontDoorLead = (id: string) => id.toLowerCase().startsWith("fd-");
export const enquirySourceLabel = (row: CommerceRow) => (text(row.source) === "front-door" ? "Front door" : "Service enquiry");

export const CUSTOMER_FIELDS: CommerceFieldDef[] = [
  { name: "name", column: "name", label: "Name", kind: "text", required: true },
  { name: "slug", column: "slug", label: "Slug", kind: "slug", help: "Made from the name when left empty." },
  { name: "domain", column: "domain", label: "Domain", kind: "text" },
  { name: "billingCurrency", column: "billing_currency", label: "Billing currency", kind: "currency" },
  { name: "notes", column: "notes", label: "Notes", kind: "textarea", wide: true },
];
/** A client's tier sets their prices: only a person sets it. */
export const CUSTOMER_TIER_FIELD: CommerceFieldDef = {
  name: "tierId", column: "tier_id", label: "Customer tier", kind: "ref", ref: "customer-tiers", help: "Sets the client's prices.",
};

export const ENGAGEMENT_KINDS = ["note", "kickoff", "review", "milestone", "deliverable", "recap"] as const;
export const ENGAGEMENT_FIELDS: CommerceFieldDef[] = [
  { name: "title", column: "title", label: "Title", kind: "text", required: true, wide: true },
  { name: "kind", column: "kind", label: "Kind", kind: "select", options: options(ENGAGEMENT_KINDS) },
  { name: "occurredOn", column: "occurred_on", label: "Date", kind: "date" },
  { name: "summary", column: "summary", label: "Summary", kind: "textarea", wide: true },
  { name: "externalUrl", column: "external_url", label: "Link", kind: "text", wide: true,
    help: "A deliverable or recap needs a link or a body." },
  { name: "bodyHtml", column: "body_html", label: "Body (HTML)", kind: "textarea", wide: true },
  { name: "phase", column: "phase", label: "Phase", kind: "text" },
  { name: "ownerName", column: "owner_name", label: "Owner", kind: "text" },
  { name: "attendees", column: "attendees", label: "Attendees", kind: "words", help: "Separate names with commas." },
  { name: "tags", column: "tags", label: "Tags", kind: "words", help: "Separate tags with commas." },
  { name: "pinned", column: "pinned", label: "Pinned", kind: "bool", help: "Shows first on the client's timeline." },
];

/** A timeline item's copy for "Duplicate": the same fields, as a new draft. */
export function engagementCopy(row: CommerceRow): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of ENGAGEMENT_FIELDS) {
    const value = row[field.column];
    if (value === null || value === undefined || value === "") continue;
    if (field.kind === "date") body[field.name] = String(value).slice(0, 10);
    else body[field.name] = value;
  }
  body.title = `${text(row.title) ?? "Item"} (copy)`;
  return body;
}

/** Licence fields any actor edits. The key and download link are separate and people only. */
export const LICENCE_FIELDS: CommerceFieldDef[] = [
  { name: "offeringName", column: "offering_name", label: "Product", kind: "text", required: true },
  { name: "variantName", column: "variant_name", label: "Edition", kind: "text" },
  { name: "seats", column: "seats", label: "Seats", kind: "int" },
  { name: "expiresAt", column: "expires_at", label: "Expires", kind: "date" },
  { name: "notes", column: "notes", label: "Notes", kind: "textarea", wide: true },
];

export const TIER_FIELDS: CommerceFieldDef[] = [
  { name: "name", column: "name", label: "Name", kind: "text", required: true },
  { name: "slug", column: "slug", label: "Slug", kind: "slug", required: true },
  { name: "rank", column: "rank", label: "Rank", kind: "int", help: "Orders the tiers on the website." },
  { name: "description", column: "description", label: "Description", kind: "textarea", wide: true },
];

/** Newest first by a date column, then by creation. */
export function byDateDesc(rows: readonly CommerceRow[], column: string): CommerceRow[] {
  const at = (row: CommerceRow) => text(row[column]) ?? text(row.created_at) ?? "";
  return [...rows].sort((a, b) => at(b).localeCompare(at(a)));
}
