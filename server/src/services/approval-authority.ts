import type { Db } from "@greatstone/db";
import { forbidden } from "../errors.js";
import { authorizationDeniedDetails, type authorizationService } from "./authorization.js";
import { isActiveCompanyOwner } from "./board-identity.js";

type Access = Pick<ReturnType<typeof authorizationService>, "decide">;
type DecideActor = Parameters<Access["decide"]>[0]["actor"];

export const APPROVAL_SELF_DECISION_CODE = "approval_self_decision";

/**
 * A person never approves what they asked for (the owner excepted), and a
 * hire needs the right to create agents, like the hire routes. Every path
 * that approves an approval calls this.
 */
export async function assertCanApproveAsPerson(
  db: Pick<Db, "select">,
  access: Access,
  actor: DecideActor,
  approval: { type: string; companyId: string; requestedByUserId: string | null },
) {
  const userId = actor.userId ?? null;
  if (
    userId &&
    approval.requestedByUserId === userId &&
    actor.source !== "local_implicit" &&
    !(await isActiveCompanyOwner(db, approval.companyId, userId))
  ) {
    throw forbidden("You asked for this, so someone else must approve it.", { code: APPROVAL_SELF_DECISION_CODE });
  }
  if (approval.type === "hire_agent") {
    const decision = await access.decide({
      actor,
      action: "agents:create",
      resource: { type: "company", companyId: approval.companyId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}
