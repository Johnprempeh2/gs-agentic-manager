import type { TourDefinition } from "./feature-tours";

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

export const WEBSITE_MODULE_TOURS = [WEBSITE_HOME_TOUR, WEBSITE_SITEMAP_TOUR, WEBSITE_EDITOR_TOUR, COMMERCE_CATALOGUE_TOUR];
