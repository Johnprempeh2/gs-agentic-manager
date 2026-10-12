import { AuditHub } from "./AuditHub";

/**
 * Canonical `/:company/activity` entrypoint for the Audit hub. The hub retains
 * the shared all-actors and privileged Agent Actions modes while Runs, Costs,
 * Budgets, and Timeline live as peer sections. The mode lives in `?mode=` so
 * `/audit` deep links can preset it and links stay shareable. The server
 * enforces both tiers.
 */
export function CompanyActivity() {
  return <AuditHub section="activity" />;
}
