import { createContext } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  PUBLIC_NETLIFY_SITE_ID,
  type WebsiteDeployChanges,
  type WebsiteEntryStatus,
  type WebsitePageStatus,
  type WebsiteSite,
} from "@greatstone/shared";
import { websiteModuleApi } from "../api/website";
import { queryKeys } from "./queryKeys";

// The one place a page's or entry's publishing state becomes words (Pages list, editors, sitemap, Collections).
// Approve, then Queue for live saves a content release for the next Deploy (no Netlify build, John 27 Nov: staging
// rebuilds cost credits and the old "On staging" label was wrong until one ran). Preview shows the draft free, drawn
// by GSAM. greatstoneint.com changes only on Deploy.

/**
 * The action names (John, 13 Nov: "It should be clear that I am deploying to staging vs live"). Every button and
 * confirm that publishes or deploys uses these, so each one names where it goes.
 */
export const STAGING_ADDRESS = "gre3833-next-db-staging.netlify.app";
export const LIVE_ADDRESS = "greatstoneint.com";
export const WEBSITE_ACTIONS = {
  publish: "Queue for live",
  deploy: `Deploy to live: ${LIVE_ADDRESS}`,
  direct: "Deploy straight to live (skip staging)",
} as const;

/** The Publish button's name: the public site's record queues for Deploy; any other site publishes to itself. */
export function publishLabel(site: Pick<WebsiteSite, "netlifySiteId" | "domain">) {
  return site.netlifySiteId === PUBLIC_NETLIFY_SITE_ID ? WEBSITE_ACTIONS.publish : `Publish to ${site.domain}`;
}

export type WebsiteStatusWord = "Draft" | "In review" | "Approved" | "Ready to go live" | "Live";

export const WEBSITE_STATUS_TONE: Record<WebsiteStatusWord, string> = {
  Draft: "bg-status-neutral-soft text-status-neutral-foreground",
  "In review": "bg-status-warning-soft text-status-warning-foreground",
  Approved: "bg-status-info-soft text-status-info-foreground",
  "Ready to go live": "bg-status-running-soft text-status-running-foreground",
  Live: "bg-status-success-soft text-status-success-foreground",
};

/** `onLive`: published content is on the public site too (see `contentIsLive`). A planned page has no content yet, so it reads Draft. */
export function websiteStatusWord(status: WebsitePageStatus | WebsiteEntryStatus, onLive: boolean): WebsiteStatusWord {
  if (status === "review") return "In review";
  if (status === "approved") return "Approved";
  if (status === "published") return onLive ? "Live" : "Ready to go live";
  return "Draft";
}

/**
 * Whether published content is on the live site. Any site but greatstoneint.com's record publishes straight to its
 * own live site. The public site's record queues its release in staging's store, so its content is live only once Deploy has
 * taken that content release to the public site (both point at the same release).
 * ponytail: one answer for the whole site, so while a Deploy is waiting every published page reads Ready to go live, even
 * one whose content did not change. Per page: record the first release each published revision went out in, and
 * call it Live when that number is at or below `liveContentRelease`.
 */
export function contentIsLive(site: Pick<WebsiteSite, "netlifySiteId"> | null | undefined, changes: WebsiteDeployChanges | null | undefined) {
  if (!site) return false;
  if (site.netlifySiteId !== PUBLIC_NETLIFY_SITE_ID) return true;
  return !!changes && changes.liveContentRelease != null && changes.liveContentRelease === changes.stagingContentRelease;
}

/** `contentIsLive` for one site. Unknown (loading, or the check is down) reads as Ready to go live, never as Live. */
export function useWebsiteContentLive(companyId: string, site: Pick<WebsiteSite, "id" | "netlifySiteId"> | null | undefined) {
  const staged = !!site && site.netlifySiteId === PUBLIC_NETLIFY_SITE_ID;
  const changes = useQuery({
    queryKey: queryKeys.website.deployChanges(companyId, site?.id ?? ""),
    queryFn: () => websiteModuleApi.deployChanges(companyId, site!.id),
    enabled: staged && !!companyId,
    retry: false,
    staleTime: 60_000,
  });
  return contentIsLive(site, changes.data);
}

/** For views deep in a tree (the sitemap): the site's `useWebsiteContentLive`, provided once at the top. */
export const WebsiteContentLiveContext = createContext(false);

/**
 * Preview (John, 27 Nov): the page's newest saved version, drawn by GSAM with the site's real header, footer and
 * stylesheet (the editor frame's own route), in a tab of its own. No Netlify build, so no credits.
 */
export function websitePagePreviewUrl(companyId: string, page: { id: string; siteId: string; latestRevisionId: string | null }) {
  if (!page.latestRevisionId) return null;
  return `/api/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(page.siteId)}/pages/${encodeURIComponent(page.id)}/live-frame?revision=${encodeURIComponent(page.latestRevisionId)}`;
}
