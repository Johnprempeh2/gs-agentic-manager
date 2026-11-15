import { eq } from "drizzle-orm";
import { issues, type Db } from "@greatstone/db";

/** A Getting started practice task (harness_kind onboarding_practice): it never wakes an agent. */
export async function isPracticeIssueById(db: Db, issueId: string) {
  const row = await db
    .select({ harnessKind: issues.harnessKind })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  return row?.harnessKind === "onboarding_practice";
}
