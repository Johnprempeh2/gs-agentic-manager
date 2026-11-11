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
// Approve, then Publish puts content on STAGING; greatstoneint.com changes only on Deploy.

export type WebsiteStatusWord = "Draft" | "In review" | "Approved" | "On staging" | "Live";

export const WEBSITE_STATUS_TONE: Record<WebsiteStatusWord, string> = {
  Draft: "bg-status-neutral-soft text-status-neutral-foreground",
  "In review": "bg-status-warning-soft text-status-warning-foreground",
  Approved: "bg-status-info-soft text-status-info-foreground",
  "On staging": "bg-status-running-soft text-status-running-foreground",
  Live: "bg-status-success-soft text-status-success-foreground",
};

/** `onLive`: published content is on the public site too (see `contentIsLive`). A planned page has no content yet, so it reads Draft. */
export function websiteStatusWord(status: WebsitePageStatus | WebsiteEntryStatus, onLive: boolean): WebsiteStatusWord {
  if (status === "review") return "In review";
  if (status === "approved") return "Approved";
  if (status === "published") return onLive ? "Live" : "On staging";
  return "Draft";
}

/**
 * Whether published content is on the live site. Any site but greatstoneint.com's record publishes straight to its
 * own live site. The public site's record publishes to staging, so its content is live only once Deploy has taken
 * staging's content release to the public site (both point at the same release).
 * ponytail: one answer for the whole site, so while a Deploy is waiting every published page reads On staging, even
 * one whose content did not change. Per page: record the first release each published revision went out in, and
 * call it Live when that number is at or below `liveContentRelease`.
 */
export function contentIsLive(site: Pick<WebsiteSite, "netlifySiteId"> | null | undefined, changes: WebsiteDeployChanges | null | undefined) {
  if (!site) return false;
  if (site.netlifySiteId !== PUBLIC_NETLIFY_SITE_ID) return true;
  return !!changes && changes.liveContentRelease != null && changes.liveContentRelease === changes.stagingContentRelease;
}

/** `contentIsLive` for one site. Unknown (loading, or the check is down) reads as On staging, never as Live. */
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
