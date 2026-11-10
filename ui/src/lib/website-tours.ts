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
      body: "Your edits wait in this panel until you save. A line appears here that counts them, with Save to draft to keep them and Undo to drop them.",
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
      body: "Draft, Waiting for approval, Approved or Live. Visitors only see a page once it is Live.",
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
  description: "The lists behind the site, such as products, team and redirects, and how a change goes live.",
  version: 1,
  flag: "enableWebsiteView",
  autoStart: false,
  label: "the collections",
  steps: [
    {
      target: "website-collection-picker",
      title: "Pick a collection",
      body: "Products, categories, team, redirects, forms and media each have their own list. Choose one here.",
    },
    {
      target: "website-collection-entries",
      title: "The entries",
      body: "One row for each entry, with its state and version. Search narrows the list. Edit opens an entry.",
    },
    {
      target: "website-collection-new",
      title: "Add one",
      body: "A new entry starts as a draft. Send it for review, and once a person approves it, it goes live with the next release.",
    },
  ],
};

/** Website, Releases tab: the site connection and every release. */
export const WEBSITE_RELEASES_TOUR: TourDefinition = {
  id: "website-releases",
  title: "Website releases",
  description: "How the site is connected, what each release put live, and who may publish.",
  version: 1,
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
      body: "Each release is one update of the live site. Saved drafts are not live until a release takes them there.",
    },
    {
      target: "website-publish",
      title: "Publish",
      body: "Puts every approved change live in one go. It costs credits each time, so it is for the site's owner to press, after the changes are approved.",
    },
    {
      target: "website-release-row",
      title: "One release",
      body: "When it went live and who sent it. Details lists the checks it passed. An owner can roll the site back to an older release from here.",
    },
  ],
};

/** The tour for each Website tab that has one. Website.tsx mounts it beside the title; Tutorials opens the tab. */
export const WEBSITE_TAB_TOURS: Partial<Record<WebsiteTab, TourDefinition>> = {
  home: WEBSITE_HOME_TOUR,
  sitemap: WEBSITE_SITEMAP_TOUR,
  editor: WEBSITE_PAGES_TOUR,
  progress: WEBSITE_PROGRESS_TOUR,
  collections: WEBSITE_COLLECTIONS_TOUR,
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

export const WEBSITE_MODULE_TOURS = [
  WEBSITE_HOME_TOUR,
  WEBSITE_SITEMAP_TOUR,
  WEBSITE_EDITOR_TOUR,
  WEBSITE_PAGES_TOUR,
  WEBSITE_PROGRESS_TOUR,
  WEBSITE_COLLECTIONS_TOUR,
  WEBSITE_RELEASES_TOUR,
  COMMERCE_CATALOGUE_TOUR,
  COMMERCE_SALES_TOUR,
];
