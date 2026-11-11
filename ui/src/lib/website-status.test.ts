import { describe, expect, it } from "vitest";
import { PUBLIC_NETLIFY_SITE_ID, WEBSITE_PAGE_STATUSES } from "@greatstone/shared";
import { contentIsLive, websiteStatusWord } from "./website-status";

describe("websiteStatusWord", () => {
  it("says every publishing state in exactly five words", () => {
    expect(WEBSITE_PAGE_STATUSES.map((status) => websiteStatusWord(status, false))).toEqual(["Draft", "Draft", "In review", "Approved", "On staging"]);
    expect(websiteStatusWord("published", true)).toBe("Live");
    const words = new Set([...WEBSITE_PAGE_STATUSES.flatMap((status) => [websiteStatusWord(status, false), websiteStatusWord(status, true)])]);
    expect([...words].sort()).toEqual(["Approved", "Draft", "In review", "Live", "On staging"]);
  });
});

describe("contentIsLive", () => {
  const publicSite = { netlifySiteId: PUBLIC_NETLIFY_SITE_ID };
  const changes = (live: number | null, staging: number | null) => ({ liveCommit: "a", stagingCommit: "b", liveContentRelease: live, stagingContentRelease: staging, commits: [] });

  it("reads Live on the public site only once Deploy has taken staging's content release live", () => {
    expect(contentIsLive(publicSite, changes(4, 4))).toBe(true);
    expect(contentIsLive(publicSite, changes(3, 4))).toBe(false);
    expect(contentIsLive(publicSite, changes(null, null))).toBe(false);
    // Unknown (the check is down or still loading) never claims Live.
    expect(contentIsLive(publicSite, undefined)).toBe(false);
  });

  it("treats any other site's publish as live", () => {
    expect(contentIsLive({ netlifySiteId: "another-site" }, undefined)).toBe(true);
    expect(contentIsLive(null, undefined)).toBe(false);
  });
});
