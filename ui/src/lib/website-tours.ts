import type { TourDefinition } from "./feature-tours";
import type { WebsiteTab } from "../components/website/WebsiteHub";

/**
 * Tours of the Website module and the Commerce catalogue. Every stop names a
 * `data-testid` or `aria-label` the page already carries, so these files need
 * no anchors of their own. A stop whose element is not on screen is left out.
 */

/** Website, Home tab. Mounted beside the page title in Website.tsx. */
export const WEBSITE_HOME_TOUR: TourDefinition = {
  id: "website-home",
  title: "Website home",
  description: "Where the site stands, what is waiting for a person, and where the sitemap and the pages are.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "Website home",
  steps: [
    {
      target: "Website section",
      title: "The parts of the website",
      body: "Everything about the site is behind these tabs. Home is this page. Sitemap lists the pages, and Pages is where you open one to edit it.",
    },
    {
      target: "website-home-hero",
      title: "Where the site stands",
      body: "A picture of the site as it is now, its name, its address and the latest release. Select the address to open the site in a new tab.",
    },
    {
      target: "website-home-needs-you",
      title: "Decisions",
      body: "Website decisions and Publish requests show here when an agent needs a person. All decisions opens the full list.",
    },
    {
      target: "website-home-tiles",
      title: "At a glance",
      body: "One tile for each part of the website: pages, sitemap, releases, build progress, traffic and collections. Select a tile to open that part.",
    },
    {
      target: "website-home-activity",
      title: "Recent activity",
      body: "Who did what and when: page saves, approvals, releases and sitemap changes.",
    },
    {
      target: "website-home-work",
      title: "Latest work from agents",
      body: "Deliverables, previews and screenshots from the website tasks. Select one to open it.",
    },
  ],
};

/** Website, Sitemap tab, Site now view. Mounted beside the page title in Website.tsx. */
export const WEBSITE_SITEMAP_TOUR: TourDefinition = {
  id: "website-sitemap",
  title: "Sitemap: Site now",
  description: "The pages that exist today, where they disagree with the plan, and the pages suggested next.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the sitemap",
  steps: [
    {
      target: "Sitemap view",
      title: "Two ways to look",
      body: "Site now shows the pages that exist today. The other views show the plan for the site. Approving a plan is for the person who owns the site, so leave that to them.",
    },
    {
      target: "sitemap-now-summary",
      title: "How many pages are built",
      body: "This line counts the built pages and says how many are in each state.",
    },
    {
      target: "Built pages",
      title: "Built pages",
      body: "One row for each page that exists, with its state. Edit page opens the page editor. View opens the page in a new tab.",
    },
    {
      target: "sitemap-now-attention",
      title: "Needs attention",
      body: "Where the approved sitemap and the real pages disagree. Read these before you edit.",
    },
    {
      target: "sitemap-now-suggested",
      title: "Suggested pages",
      body: "Pages in the plan that are not built yet. Build this page starts one. Dismiss hides a suggestion, and Bring back returns it.",
    },
  ],
};

/**
 * The page editor fills the screen and has no page bar, so PageTourButton runs
 * this tour hidden: it opens once on a person's first visit, and Tutorials replays it.
 */
export const WEBSITE_EDITOR_TOUR: TourDefinition = {
  id: "website-editor",
  title: "Page editor",
  description: "Pick a page, change its words, save to the draft, look at older versions and ask the page's agent for a change.",
  version: 1,
  flag: "enableWebsiteView",
  // Tutorials opens the first built page; the path is only where to pick one when it cannot.
  route: { match: /^\/website\/sites\/[^/]+\/pages\/[^/]+\/design\/?$/, path: "/website?tab=editor" },
  label: "the page editor",
  steps: [
    {
      title: "The page editor",
      body: "The chat with the page's agent is on the left and the page is on the right. What you save here goes to the draft, never straight to the public site.",
    },
    {
      target: "Page",
      title: "Pick a page",
      body: "This list switches to another built page without leaving the editor.",
    },
    {
      // The Editing switch and the page frame carry no anchor yet, so this stop is a card about the page.
      title: "Change the words",
      body: "Editing on, at the top, lets you change text. Select any text on the page, then select the pencil and type. Turn editing off to click through the page as a visitor would.",
    },
    {
      target: ["Unsaved edits", "Live design chat"],
      title: "Save to draft",
      body: "Your edits wait in this panel until you save. A line appears here that counts them, with Save to draft to keep them and Undo to drop them. If you can approve pages, Save and approve saves them and approves the page in one go.",
    },
    {
      target: "Versions",
      title: "Versions",
      body: "Every save makes a new version. Open this to see who made each one, look at an older version, and restore it if you need to.",
    },
    {
      target: "Message the agent",
      title: "Ask the page's agent",
      body: "For anything bigger than a change of words, say what you want here and send it. The agent makes the change and shows it on the page.",
    },
  ],
};

/** Commerce, Catalogue, Offerings. In CORE_TOURS, so the page bar carries its Show me around button. */
export const COMMERCE_CATALOGUE_TOUR: TourDefinition = {
  id: "commerce-catalogue",
  title: "Commerce catalogue",
  description: "Find a product by name, narrow the list by category, and see how many are showing.",
  version: 1,
  flag: "enableWebsiteView",
  route: { match: /^\/commerce\/offerings\/?$/, path: "/commerce/offerings" },
  autoStart: false,
  label: "the catalogue",
  steps: [
    {
      target: "commerce-catalogue-list",
      title: "The catalogue",
      body: "Everything the website sells, listed by name and grouped by category. Select a row to open it. New records start as drafts, and only published records show on the website.",
    },
    {
      target: "Search offerings",
      title: "Find one",
      body: "Type part of a name, a vendor, a category or a code. The list narrows as you type.",
    },
    {
      target: "Category",
      title: "One category at a time",
      body: "Pick a category to see only its rows. Needs attention, beside this, shows the rows with no price, no short description or no category.",
    },
    {
      target: "commerce-catalogue-count",
      title: "How many are showing",
      body: "This line says how many rows match your search and filters, out of the whole catalogue.",
    },
  ],
};

/** Website, Pages tab: the list of built pages. */
export const WEBSITE_PAGES_TOUR: TourDefinition = {
  id: "website-pages",
  title: "Website pages",
  description: "Every built page of the site, its state, and how to open one in the editor.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the pages",
  steps: [
    {
      target: "website-pages-list",
      title: "Every built page",
      body: "One row for each page that exists, with its name and address. Pages the sitemap suggests but nobody has built stay on the Sitemap tab.",
    },
    {
      target: "website-page-status",
      title: "Its state",
      body: "Draft, In review, Approved, On staging or Live. Publish puts approved pages on staging; visitors only see a page once Deploy makes it Live.",
    },
    {
      target: "website-pages-edit",
      title: "Open the editor",
      body: "Edit pages opens the first page full screen. Edit on a row opens that page. You can switch pages inside the editor too.",
    },
  ],
};

/** Website, Progress tab: the website project's task tree. */
export const WEBSITE_PROGRESS_TOUR: TourDefinition = {
  id: "website-progress",
  title: "Website progress",
  description: "The website project's work as a tree, what is blocked, and what is finished.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the build progress",
  steps: [
    {
      target: "Task tree summary",
      title: "How far along it is",
      body: "The website project, who leads it, how many of its tasks are done, and the first thing holding the work up.",
    },
    {
      target: "Task tree",
      title: "The work, branch by branch",
      body: "Each box is a task, under the task it belongs to. Select a box to open the task.",
    },
    {
      target: "Only what's blocked and why",
      title: "Only what is stuck",
      body: "Turn this on to hide everything that is moving and see only blocked tasks, each with what it waits for.",
    },
    {
      target: "Show finished work",
      title: "Finished work",
      body: "Finished tasks are hidden to keep the tree short. Turn this on to see them.",
    },
  ],
};

/** Website, Collections tab: products, team, redirects, forms and media. */
export const WEBSITE_COLLECTIONS_TOUR: TourDefinition = {
  id: "website-collections",
  title: "Website collections",
  description: "The lists behind the site, such as products, services, team and redirects, and how a change goes live.",
  version: 3,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the collections",
  steps: [
    {
      target: "website-collection-picker",
      title: "Pick a collection",
      body: "Products, categories, team, redirects, forms, services, service categories and media each have their own list. Choose one here. The services are the ones the website lists under its services catalogue.",
    },
    {
      target: "website-collection-entries",
      title: "The entries",
      body: "One row for each entry, with its state and version. Search narrows the list. Edit opens an entry.",
    },
    {
      target: "website-collection-new",
      title: "Add one",
      body: "A new entry starts as a draft. Send it for review, or, if you can approve, use Save and approve. Once it is approved, Publish puts it on staging and Deploy puts it on the live site.",
    },
  ],
};

/** Website, Releases tab: the site connection and every release. */
export const WEBSITE_RELEASES_TOUR: TourDefinition = {
  id: "website-releases",
  title: "Website releases",
  description: "How the site is connected, what each Publish sent to staging, and who may publish.",
  version: 2,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the releases",
  steps: [
    {
      target: "website-site-connection",
      title: "Site connection",
      body: "Where the site lives and how GSAM reaches it. Only people with Publish rights can change it.",
    },
    {
      target: "website-releases",
      title: "Releases",
      body: "Each release is one Publish. Saved drafts stay drafts until they are approved and a Publish takes them to staging.",
    },
    {
      target: "website-publish",
      title: "Publish",
      body: "Puts every approved change on staging in one go. Deploy then takes staging to the live site. Each Publish costs credits, so it is for the site's owner to press, after the changes are approved.",
    },
    {
      target: "website-release-row",
      title: "One release",
      body: "When it was sent and who sent it. Details lists the checks it passed. An owner can roll the site back to an older release from here.",
    },
  ],
};

/** Website, Preview tab: the live site and the one being worked on, in a frame. */
export const WEBSITE_PREVIEW_TOUR: TourDefinition = {
  id: "website-preview",
  title: "Website preview",
  description: "The live site and the one being worked on, at laptop, tablet or phone width.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the preview",
  steps: [
    {
      target: "website-preview-controls",
      title: "Which site, and how wide",
      body: "Live is the public site. In development is the site being worked on. Side by side shows both. Laptop, Tablet and Phone set the width.",
    },
    {
      target: "website-preview-frame",
      title: "The site itself",
      body: "The pages load here as a visitor sees them, and you can click around. If a site will not load in the frame, open it in a new tab instead.",
    },
    {
      target: "Live preview",
      title: "The workspace preview",
      body: "The website project's own preview, run from its workspace. Start it here when it is not running.",
    },
    {
      target: "Deploy previews",
      title: "Preview links",
      body: "Preview links agents post on website tasks. Show here loads one in the frame above.",
    },
  ],
};

/** Website, Style tab: the colours, fonts and building blocks read from the site. */
export const WEBSITE_STYLE_TOUR: TourDefinition = {
  id: "website-style",
  title: "Website style",
  description: "The colours, fonts and building blocks the site uses, read from its own stylesheet.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the style",
  steps: [
    {
      target: "website-style-source",
      title: "Where it was read from",
      body: "The site's address, how many stylesheets GSAM read and when. Read again picks up a change. Click any value on this tab to copy it.",
    },
    {
      target: "website-style-colour",
      title: "Colours",
      body: "Each colour the site uses, grouped by what it is for. Ask an agent opens a task to change one.",
    },
    {
      target: "website-style-contrast-pair",
      title: "Text on background",
      body: "Each text colour on the background it sits on. Body text needs AA, a contrast of at least 4.5 to 1.",
    },
    {
      target: "website-style-font",
      title: "Fonts",
      body: "The families the site loads, drawn in the site's own fonts, with the type scale below them.",
    },
    {
      target: "website-style-block",
      title: "Building blocks",
      body: "The buttons, links, cards and pills the site repeats, drawn as its stylesheet draws them, with the class to use.",
    },
  ],
};

/** Website, Documents tab: the client portal's documents. */
export const WEBSITE_DOCUMENTS_TOUR: TourDefinition = {
  id: "website-documents",
  title: "Portal documents",
  description: "The engagement packs, NDAs and terms each client reads in the portal, and who approves them.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the portal documents",
  steps: [
    {
      target: "website-documents-new",
      title: "Start a draft",
      body: "Agents and staff write a draft for one client company. Submit sends it for approval.",
    },
    {
      target: "website-documents-client",
      title: "One client at a time",
      body: "Pick a client company to see only its documents.",
    },
    {
      target: "Portal documents",
      title: "Each document and its state",
      body: "Draft, Waiting for approval, Published, Withdrawn or Replaced. A portal approver selects Approve and publish to show a document to the client, and can withdraw it later.",
    },
  ],
};

/** Website, People tab: website admin staff, portal approvers and client sign-ins. */
export const WEBSITE_PEOPLE_TOUR: TourDefinition = {
  id: "website-people",
  title: "Website people",
  description: "Who signs in to the website admin, who approves portal documents, and who sees each client company.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "people and access",
  steps: [
    {
      target: "website-access-staff",
      title: "Staff",
      body: "Everyone who works in the website admin, and what their role lets them do. Staff are added on the website itself.",
    },
    {
      target: "website-access-approvers",
      title: "Portal approvers",
      body: "Staff who approve and publish documents in the client portal. They still sign in to the website to do it.",
    },
    {
      target: "website-access-clients",
      title: "Client companies",
      body: "Who from each client company signs in to the portal, and who manages the company there. Only a person with Publish rights changes access.",
    },
  ],
};

/** The tour for each Website tab that has one. Website.tsx mounts it beside the title; Tutorials opens the tab. */
export const WEBSITE_TAB_TOURS: Partial<Record<WebsiteTab, TourDefinition>> = {
  home: WEBSITE_HOME_TOUR,
  preview: WEBSITE_PREVIEW_TOUR,
  sitemap: WEBSITE_SITEMAP_TOUR,
  editor: WEBSITE_PAGES_TOUR,
  progress: WEBSITE_PROGRESS_TOUR,
  collections: WEBSITE_COLLECTIONS_TOUR,
  style: WEBSITE_STYLE_TOUR,
  documents: WEBSITE_DOCUMENTS_TOUR,
  people: WEBSITE_PEOPLE_TOUR,
  releases: WEBSITE_RELEASES_TOUR,
};

/** Commerce, Sales: quotes, orders, invoices, licences and payments. In CORE_TOURS. */
export const COMMERCE_SALES_TOUR: TourDefinition = {
  id: "commerce-sales",
  title: "Commerce sales",
  description: "The website's quotes, orders and invoices, and how one leads to the next.",
  version: 1,
  flag: "enableWebsiteView",
  route: { match: /^\/commerce\/(quotes|orders|invoices|licences|payments)\/?$/, path: "/commerce/quotes" },
  autoStart: false,
  label: "Commerce sales",
  steps: [
    {
      target: "Commerce area",
      title: "Three areas",
      body: "Sales is what customers asked for and bought. Catalogue is what the site sells. Clients is the companies and enquiries behind them.",
    },
    {
      target: "Commerce records",
      title: "Quotes to invoices",
      body: "A quote is a request from the website. An accepted quote becomes an order, and an order becomes an invoice when it gets an invoice number.",
    },
    {
      target: "commerce-list",
      title: "The list",
      body: "Newest first, with the total and the state. Select a row to see its details, its items and the records linked to it.",
    },
  ],
};

/** Commerce, Catalogue: every section but Offerings, which has its own tour. In CORE_TOURS. */
export const COMMERCE_CATALOGUE_SETUP_TOUR: TourDefinition = {
  id: "commerce-catalogue-setup",
  title: "Commerce catalogue set-up",
  description: "Vendors, categories, pricing rules, customer tiers, the display rate and price-book imports.",
  version: 2,
  flag: "enableWebsiteView",
  route: { match: /^\/commerce\/(vendors|categories|pricing-rules|customer-tiers|currency|imports)\/?$/, path: "/commerce/vendors" },
  autoStart: false,
  label: "the catalogue set-up",
  steps: [
    {
      title: "Behind the offerings",
      body: "These sections hold what the offerings draw on: who makes them, how they are grouped and how they are priced. Offerings has its own tour.",
    },
    {
      target: "Commerce records",
      title: "One section at a time",
      body: "Vendors, Categories, Pricing rules, Customer tiers, Currency and Price-book import. Pick one here.",
    },
    {
      target: ["commerce-catalogue-list", "commerce-tiers"],
      title: "The list",
      body: "Select a row to open it, or add one with the New button. Vendors, categories and pricing rules start as drafts, and only published ones show on the website. Customer tiers save straight away. A pricing rule shows what it does to real prices, so check a draft before publishing it.",
    },
    {
      target: "Display rate",
      title: "The display rate",
      body: "The rate is US dollars for one pound. The website shows and charges the dollar price divided by it, rounded to the whole pound. Type a new rate to preview real prices; only a person saves it, after a confirm, and every change is kept in the history.",
    },
    {
      target: "commerce-import-new",
      title: "Price-book import",
      body: "Export the catalogue as a CSV price book, edit it, then choose it here. GSAM compares it with the catalogue and shows the plan as a dry run. Nothing changes until a person applies it.",
    },
  ],
};

/** Commerce, Clients: client companies, enquiries and leads, and portal receipts. In CORE_TOURS. */
export const COMMERCE_CLIENTS_TOUR: TourDefinition = {
  id: "commerce-clients",
  title: "Commerce clients",
  description: "The client companies on the website, their enquiries and leads, and the receipts for documents they accept.",
  version: 1,
  flag: "enableWebsiteView",
  route: { match: /^\/commerce\/(customers|enquiries|portal-acceptances)\/?$/, path: "/commerce/customers" },
  autoStart: false,
  label: "Commerce clients",
  steps: [
    {
      title: "Who buys",
      body: "Clients is the companies who buy from the website, the enquiries that come in, and the receipts for portal documents they accept.",
    },
    {
      target: "Commerce records",
      title: "Three lists",
      body: "Client companies, Enquiries and leads, and Portal receipts. Pick one here.",
    },
    {
      target: "commerce-clients",
      title: "Client companies",
      body: "Open a company for its details, its people, its timeline and its licences. New client adds one on the website.",
    },
    {
      target: "commerce-enquiries",
      title: "Enquiries and leads",
      body: "Service enquiries and leads from the website, open ones first. Show narrows them by status. Set a status as you work each one. A front door lead with a team offers its agent package as a .zip.",
    },
    {
      target: "commerce-receipts",
      title: "Portal receipts",
      body: "Each time a client accepts a portal document, the website emails them a receipt. A person can send one again if it did not arrive.",
    },
  ],
};

/** Commerce, one client company (admin parity round 2): seat requests beside the details, timeline and licences. In CORE_TOURS. */
export const COMMERCE_CLIENT_TOUR: TourDefinition = {
  id: "commerce-client-detail",
  title: "A client company",
  description: "One client's details and people, the seats their company admin asked for, and their licences.",
  version: 1,
  flag: "enableWebsiteView",
  route: { match: /^\/commerce\/customers\/[^/]+\/?$/, path: "/commerce/customers" },
  autoStart: false,
  label: "this client",
  steps: [
    {
      target: "Details",
      title: "Details",
      body: "The client as the website holds it. Edit client changes the name, domain, notes and currency. Only a person sets the customer tier, because it sets their prices.",
    },
    {
      target: "People",
      title: "People",
      body: "Everyone who can sign in to this client's portal on the website.",
    },
    {
      target: "commerce-client-seat-requests",
      title: "Seat requests",
      body: "When the client's company admin asks for a new person on the website, the request waits here. A person approves it, which adds them to the portal, or declines it. Clients lists every request still waiting.",
    },
    {
      target: "commerce-client-licences",
      title: "Licences",
      body: "The licences the client holds, with the key masked. A person issues a new one here.",
    },
  ],
};

/** Commerce, one quote, order or invoice (admin parity round 2): the buyer's PO file beside the details. In CORE_TOURS. */
export const COMMERCE_RECORD_TOUR: TourDefinition = {
  id: "commerce-record-detail",
  title: "A quote, order or invoice",
  description: "What one sale holds: its details, the buyer's purchase order file, its items and who bought it.",
  version: 1,
  flag: "enableWebsiteView",
  route: { match: /^\/commerce\/(quotes|orders|invoices)\/[^/]+\/?$/, path: "/commerce/quotes" },
  autoStart: false,
  label: "this record",
  steps: [
    {
      target: "Details",
      title: "Details",
      body: "The state, totals, PO reference and dates, as the website holds them.",
    },
    {
      target: "commerce-po-download",
      title: "The buyer's purchase order",
      body: "When the buyer uploaded a PO with their quote, Download PO fetches it from the website for you. It is never a public link, and each download is recorded.",
    },
    {
      target: "Items",
      title: "Items",
      body: "What was quoted or bought, line by line.",
    },
    {
      target: "Customer",
      title: "Who bought it",
      body: "The client company, with links to the client and to all their records of this kind.",
    },
  ],
};

export const WEBSITE_MODULE_TOURS = [
  WEBSITE_HOME_TOUR,
  WEBSITE_SITEMAP_TOUR,
  WEBSITE_EDITOR_TOUR,
  WEBSITE_PAGES_TOUR,
  WEBSITE_PROGRESS_TOUR,
  WEBSITE_COLLECTIONS_TOUR,
  WEBSITE_RELEASES_TOUR,
  WEBSITE_PREVIEW_TOUR,
  WEBSITE_STYLE_TOUR,
  WEBSITE_DOCUMENTS_TOUR,
  WEBSITE_PEOPLE_TOUR,
  COMMERCE_CATALOGUE_TOUR,
  COMMERCE_CATALOGUE_SETUP_TOUR,
  COMMERCE_SALES_TOUR,
  COMMERCE_CLIENTS_TOUR,
  COMMERCE_CLIENT_TOUR,
  COMMERCE_RECORD_TOUR,
];
