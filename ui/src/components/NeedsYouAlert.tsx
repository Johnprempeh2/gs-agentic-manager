import { useEffect, useRef } from "react";
import type { NeedsMe } from "@greatstone/shared";
import { useNeedsMe } from "../hooks/useDecisionsFeed";
import { useCompany } from "../context/CompanyContext";
import { useOptionalToastActions } from "../context/ToastContext";

/** Decisions on screen now, by id, with the line to show for each. */
export function decisionLines(needsMe: NeedsMe): Map<string, string> {
  const lines = new Map<string, string>();
  for (const card of needsMe.decisions) {
    if (card.kind === "outage") continue;
    lines.set(card.id, card.task?.title ?? card.title);
  }
  return lines;
}

/** True when this browser will not show GSAM's phone or desktop notifications. */
export function pushBlocked(): boolean {
  return typeof Notification === "undefined" || Notification.permission !== "granted";
}

/**
 * When a new decision arrives while GSAM is open and this browser cannot show
 * notifications (blocked, never allowed, or not supported), say so in the app
 * instead, with a way straight to it. Browsers that show notifications already
 * get one from the push service, so they get nothing extra here.
 */
export function NeedsYouAlert() {
  const { selectedCompanyId } = useCompany();
  const { data } = useNeedsMe(selectedCompanyId);
  const toasts = useOptionalToastActions();
  // Decisions already seen in this company: only ones that arrive later alert.
  const seen = useRef<{ companyId: string | null; ids: Set<string> } | null>(null);

  useEffect(() => {
    if (!data || data.companyId !== selectedCompanyId) return;
    const lines = decisionLines(data);
    const before = seen.current;
    seen.current = { companyId: selectedCompanyId, ids: new Set(lines.keys()) };
    if (!before || before.companyId !== selectedCompanyId) return;
    const fresh = [...lines].filter(([id]) => !before.ids.has(id));
    if (fresh.length === 0 || !pushBlocked()) return;
    toasts?.pushToast({
      dedupeKey: `needs-you:${fresh.map(([id]) => id).join(",")}`,
      title: fresh.length === 1 ? "Something new needs you" : `${fresh.length} new things need you`,
      body: fresh.length === 1 ? fresh[0]![1] : undefined,
      tone: "info",
      action: { label: "Open Decisions", href: "/decisions" },
    });
  }, [data, selectedCompanyId, toasts]);

  return null;
}
