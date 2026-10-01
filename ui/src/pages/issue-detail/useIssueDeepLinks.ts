import { useRef, useCallback, useEffect } from "react";
import type { IssuePropertiesDocumentDeepLink } from "../../components/IssueProperties";
import { resolveIssueDocumentDeepLink } from "../../lib/issue-document-deep-link";
import type { Issue, IssueWorkProduct, IssueAttachment } from "@greatstone/shared";
import type { Dispatch, SetStateAction } from "react";
import type { Location } from "@/lib/router";

export type UseIssueDeepLinksInput = {
  setDocumentDeepLink: Dispatch<SetStateAction<(IssuePropertiesDocumentDeepLink & { issueId: string; }) | null>>;
  setDetailTab: Dispatch<SetStateAction<string>>;
  setHandoffFocusSignal: Dispatch<SetStateAction<number>>;
  taskInterfaceSettingsLoaded: boolean;
  taskChatShellEnabled: boolean;
  isMobile: boolean;
  setMobilePropsOpen: Dispatch<SetStateAction<boolean>>;
  suppressPanelUntilPlan: boolean;
  issue: Issue | undefined;
  setPanelBeforePlanOverrideIssueId: Dispatch<SetStateAction<string | null>>;
  setPanelVisible: (visible: boolean) => void;
  issueId: string | undefined;
  requestPanelMaximize: () => void;
  location: Location<any>;
  clearPanelMaximizeRequest: () => void;
  workProducts: IssueWorkProduct[] | undefined;
  attachments: IssueAttachment[] | undefined;
};

export function useIssueDeepLinks({
  setDocumentDeepLink,
  setDetailTab,
  setHandoffFocusSignal,
  taskInterfaceSettingsLoaded,
  taskChatShellEnabled,
  isMobile,
  setMobilePropsOpen,
  suppressPanelUntilPlan,
  issue,
  setPanelBeforePlanOverrideIssueId,
  setPanelVisible,
  issueId,
  requestPanelMaximize,
  location,
  clearPanelMaximizeRequest,
  workProducts,
  attachments,
}: UseIssueDeepLinksInput) {
  const lastMaximizeRequestKeyRef = useRef<string | null>(null);
  const routeIssueDocumentDeepLink = useCallback(
    (hash: string) => {
      const route = resolveIssueDocumentDeepLink(hash);
      if (!route) return false;

      if (route.kind === "continuation-summary") {
        setDocumentDeepLink(null);
        setDetailTab("activity");
        setHandoffFocusSignal((current) => current + 1);
        return true;
      }

      // The classic interface owns document links in its center-column
      // Documents section. Do not open its tab-less properties panel.
      if (!taskInterfaceSettingsLoaded || !taskChatShellEnabled) return false;

      if (isMobile) {
        setMobilePropsOpen(true);
      } else {
        if (suppressPanelUntilPlan && issue?.id) {
          setPanelBeforePlanOverrideIssueId(issue.id);
        }
        setPanelVisible(true);
        // `viewer=full` (LOOA-2181): external links (Slack approval cards)
        // land with the pane maximized. Mobile uses the sheet, which is
        // already full-screen, so the request is desktop-only.
        if (route.maximize) {
          const requestKey = `${issueId ?? ""}::${hash}`;
          if (lastMaximizeRequestKeyRef.current !== requestKey) {
            lastMaximizeRequestKeyRef.current = requestKey;
            requestPanelMaximize();
          }
        }
      }
      const targetIssueId = issue?.id ?? issueId ?? "";
      setDocumentDeepLink((current) => ({
        issueId: targetIssueId,
        tab: route.tab,
        documentKey: route.documentKey,
        requestId:
          current?.issueId === targetIssueId ? current.requestId + 1 : 1,
      }));
      return true;
    },
    [
      taskInterfaceSettingsLoaded,
      isMobile,
      issue?.id,
      issueId,
      setPanelVisible,
      requestPanelMaximize,
      suppressPanelUntilPlan,
      taskChatShellEnabled,
    ],
  );

  useEffect(() => {
    if (!routeIssueDocumentDeepLink(location.hash)) {
      setDocumentDeepLink(null);
      // The deep link ended (hash cleared or issue changed): drop any
      // maximize request the panel never consumed so it cannot maximize a
      // later, unrelated panel, and re-arm for the next viewer=full hash.
      lastMaximizeRequestKeyRef.current = null;
      clearPanelMaximizeRequest();
    }
  }, [
    issueId,
    location.hash,
    routeIssueDocumentDeepLink,
    clearPanelMaximizeRequest,
  ]);

  // Leaving the issue page entirely also ends the deep link's lifetime.
  useEffect(
    () => () => {
      clearPanelMaximizeRequest();
    },
    [clearPanelMaximizeRequest],
  );

  // React Router does not emit a location update when the user clicks a link
  // whose hash is already current. Capture that repeated intent so a manually
  // collapsed document reopens and scrolls back into view.
  useEffect(() => {
    const handleSameHashDocumentClick = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const rawHref = anchor.getAttribute("href");
      if (!rawHref) return;

      let targetUrl: URL;
      try {
        targetUrl = new URL(rawHref, window.location.href);
      } catch {
        return;
      }
      const sameIssue =
        rawHref.startsWith("#") ||
        (targetUrl.pathname === location.pathname &&
          targetUrl.search === location.search);
      if (!sameIssue || targetUrl.hash !== location.hash) return;
      routeIssueDocumentDeepLink(targetUrl.hash);
    };

    document.addEventListener("click", handleSameHashDocumentClick, true);
    return () =>
      document.removeEventListener("click", handleSameHashDocumentClick, true);
  }, [
    location.hash,
    location.pathname,
    location.search,
    routeIssueDocumentDeepLink,
  ]);

  // Scroll + briefly highlight work-product / direct-attachment anchors so the
  // company Artifacts page (PAP-10359) can deep-link to a specific artifact in
  // its issue context. Retries while the section data loads in.
  useEffect(() => {
    const match = location.hash.match(/^#(work-product|attachment)-(.+)$/);
    if (!match) return;
    const targetId = `${match[1]}-${decodeURIComponent(match[2]!)}`;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      if (cancelled) return;
      const element = document.getElementById(targetId);
      if (!element) {
        if (attempts < 30) {
          attempts += 1;
          timer = setTimeout(tryScroll, 100);
        }
        return;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("ring-2", "ring-primary/50", "transition-shadow");
      timer = setTimeout(
        () =>
          element.classList.remove(
            "ring-2",
            "ring-primary/50",
            "transition-shadow",
          ),
        3000,
      );
    };
    tryScroll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [location.hash, workProducts, attachments]);

  return {

  };
}
