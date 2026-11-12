import { createContext, useContext, type ReactNode } from "react";
import type { DeepDiveRecordSummary, DeepDiveScope } from "@greatstone/shared";
import { casesApi } from "@/api/cases";

// One client's Deep Dive (GRE-4430). The portal provides the scope; every tab
// reads and writes inside it, and links stay inside the same portal.

export interface DeepDivePortalScope extends DeepDiveScope {
  record: DeepDiveRecordSummary;
}

const DeepDiveScopeContext = createContext<DeepDivePortalScope | null>(null);

export function DeepDiveScopeProvider({ value, children }: { value: DeepDivePortalScope; children: ReactNode }) {
  return <DeepDiveScopeContext.Provider value={value}>{children}</DeepDiveScopeContext.Provider>;
}

export function useDeepDiveScope(): DeepDivePortalScope {
  const scope = useContext(DeepDiveScopeContext);
  if (!scope) throw new Error("useDeepDiveScope is used outside a Deep Dive portal");
  return scope;
}

/** The portal's own path for a tab or item, for example dd("/sessions"). */
export function deepDivePath(recordCaseId: string, path = ""): string {
  return `/deep-dive/${recordCaseId}${path}`;
}

export function useDeepDiveHref(): (path?: string) => string {
  const { recordCaseId } = useDeepDiveScope();
  return (path = "") => deepDivePath(recordCaseId, path);
}

/** The record and its own items (streams, later gates and registers): never another Deep Dive's. */
export async function listDeepDiveCases(scope: DeepDivePortalScope) {
  return casesApi.listChildren(scope.companyId, scope.recordCaseId);
}

export function deepDiveCasesQueryKey(scope: DeepDiveScope) {
  return ["cases", scope.companyId, "deep-dive", scope.recordCaseId] as const;
}

/** The tiles page: every client's Deep Dive. */
export const DEEP_DIVE_TILES_PATH = "/deep-dive";

/**
 * A company-wide Deep Dive path ("/deep-dive/files", or an overview step's
 * href) as the same screen inside one client's portal.
 */
export function deepDivePortalHref(recordCaseId: string, href: string): string {
  const match = /^\/deep-dive(\/.*)?$/.exec(href);
  if (!match) return href;
  const rest = match[1] ?? "";
  const path = rest === "/overview" ? "" : rest === "/files" ? "/documents" : rest;
  return deepDivePath(recordCaseId, path);
}
