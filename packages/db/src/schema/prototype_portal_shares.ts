import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { organisations } from "./organisations.js";

// Prototypes shown in a client's website portal (John, 14 Nov). One row per
// prototype (a link deliverable, named like every deliverable by its task and
// key) that a person made "Visible to <client>". Agents never write it. The
// row holds the client and the address that person shared: the portal push
// sends a prototype only while it still belongs to that client and its latest
// version is still at that address, so a move or a new address hides it.
// Turning sharing off deletes the row; the activity log keeps the history.
export const prototypePortalShares = pgTable(
  "prototype_portal_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    deliverableKey: text("deliverable_key").notNull(),
    organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
    // The website organisation (website customers.id) the portal shows it to.
    websiteOrganisationId: text("website_organisation_id").notNull(),
    sharedUrl: text("shared_url").notNull(),
    sharedByUserId: text("shared_by_user_id").notNull(),
    sharedAt: timestamp("shared_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    prototypeUq: uniqueIndex("prototype_portal_shares_prototype_uq").on(table.companyId, table.issueId, table.deliverableKey),
    websiteOrganisationIdx: index("prototype_portal_shares_website_organisation_idx").on(table.companyId, table.websiteOrganisationId),
  }),
);
