import { and, eq, inArray } from "drizzle-orm";
import { agents, authUsers, companyMemberships, type Db } from "@greatstone/db";
import type { RequestStepsPayload, RequestStepsResultSecret } from "@greatstone/shared";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { accessService } from "./access.js";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";
import { secretService } from "./secrets.js";
import { getHiddenSettings } from "./settings-visibility.js";

// Step-by-step cards (request_steps). The one security-critical part is the
// optional secret: the person types it, the server saves it straight into the
// company secrets, and it is never written to the interaction, the activity
// log, a comment, a run or any response. Only the secret's id and name leave
// this file.

type Actor = Parameters<ReturnType<typeof accessService>["decide"]>[0]["actor"];

const SECRETS_HIDDEN_KEY = "company.secrets";

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Who may type the secret on this card, worked out when the card is made so
 * the card (and the agent) can say who to ask. A person with no membership row
 * (the local board) counts as able; Done re-checks the real permission.
 */
export async function stepsSecretAccess(
  db: Db,
  companyId: string,
  addresseeUserId: string | null,
): Promise<{ addresseeCanSave: boolean; whoCan: string[] }> {
  if (getHiddenSettings().has(SECRETS_HIDDEN_KEY)) {
    return { addresseeCanSave: false, whoCan: [] };
  }
  const members = await db
    .select({
      userId: companyMemberships.principalId,
      role: companyMemberships.membershipRole,
      status: companyMemberships.status,
      name: authUsers.name,
      email: authUsers.email,
    })
    .from(companyMemberships)
    .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user")));
  const canSave = (member: (typeof members)[number]) => member.status === "active" && member.role !== "viewer";
  const rank = (role: string | null) => (role === "owner" ? 0 : role === "admin" ? 1 : 2);
  const whoCan = members
    .filter(canSave)
    .sort((left, right) => rank(left.role) - rank(right.role))
    .map((member) => member.name?.trim() || member.email?.trim() || "")
    .filter(Boolean)
    .slice(0, 5);
  const addressee = addresseeUserId ? members.find((member) => member.userId === addresseeUserId) : undefined;
  return { addresseeCanSave: addressee ? canSave(addressee) : true, whoCan };
}

/** Agents in `agentIds` that belong to `companyId`; the rest are refused. */
export async function sameCompanyAgentIds(db: Db, companyId: string, agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
  const found = new Set(rows.map((row) => row.id));
  return agentIds.filter((id) => found.has(id));
}

/** Throws unless this person may save company secrets. */
export async function assertCanSaveStepsSecret(db: Db, actor: Actor, companyId: string) {
  if (actor.type !== "board") throw forbidden("Only a person can save a secret from a step-by-step card");
  if (getHiddenSettings().has(SECRETS_HIDDEN_KEY)) {
    throw forbidden("Secret management is managed by the hosting operator on this instance");
  }
  const decision = await accessService(db).decide({
    actor,
    action: "secrets:read",
    resource: { type: "company", companyId },
  });
  if (!decision.allowed) {
    throw forbidden("You need permission to manage this company's secrets to finish these steps");
  }
}

/**
 * Saves the typed value under `secret.secretName` (a new version when the
 * name exists) and, when asked and allowed, links it to the named agents as
 * `access.<adapterEnvKey>`. Runs inside the card's resolution transaction.
 */
export async function saveStepsSecret(input: {
  db: Db;
  tx: Db;
  actor: Actor;
  companyId: string;
  interactionId: string;
  issueId: string;
  secret: NonNullable<RequestStepsPayload["secret"]>;
  value: string;
}): Promise<RequestStepsResultSecret> {
  const { db, tx, actor, companyId, secret } = input;
  const userId = actor.type === "board" ? actor.userId ?? "board" : "board";
  const secrets = secretService(tx);
  let saved: { id: string; name: string; latestVersion?: number | null };
  let created = false;
  try {
    const existing = await secrets.getByName(companyId, secret.secretName);
    if (existing) {
      saved = await secrets.rotate(existing.id, { value: input.value }, { userId, agentId: null });
    } else {
      saved = await secrets.create(
        companyId,
        {
          name: secret.secretName,
          provider: getConfiguredSecretProvider(),
          value: input.value,
          description: secret.description,
        },
        { userId, agentId: null },
      );
      created = true;
    }
  } catch (error) {
    // A provider error can quote what it was given; never pass it on.
    logger.warn(
      { errName: error instanceof Error ? error.name : typeof error, status: (error as HttpError)?.status, interactionId: input.interactionId },
      "request_steps: saving the secret failed",
    );
    throw unprocessable("Could not save the secret. Nothing was saved; try again or ask an owner.");
  }
  await logActivity(tx, {
    companyId,
    actorType: "user",
    actorId: userId,
    action: created ? "secret.created" : "secret.rotated",
    entityType: "secret",
    entityId: saved.id,
    details: created
      ? { name: saved.name, source: "request_steps", interactionId: input.interactionId, issueId: input.issueId }
      : { version: saved.latestVersion ?? null, source: "request_steps", interactionId: input.interactionId, issueId: input.issueId },
  });

  const wanted = secret.adapterEnvKey ? secret.linkToAgentIds ?? [] : [];
  const linkedAgentIds: string[] = [];
  let linkingNeedsOwner = false;
  if (wanted.length > 0 && secret.adapterEnvKey) {
    const access = accessService(db);
    const agentSvc = agentService(tx);
    const configPath = `access.${secret.adapterEnvKey}`;
    for (const agentId of await sameCompanyAgentIds(tx, companyId, wanted)) {
      const decision = await access.decide({
        actor,
        action: "agent_config:update",
        resource: { type: "agent", companyId, agentId },
        scope: { requiresChangeGrant: true },
      });
      if (!decision.allowed) {
        linkingNeedsOwner = true;
        continue;
      }
      const agent = await agentSvc.getById(agentId);
      if (!agent || agent.companyId !== companyId) continue;
      const adapterConfig = {
        ...readObject(agent.adapterConfig),
        [configPath]: { type: "secret_ref", secretId: saved.id, version: "latest" },
      };
      await agentSvc.update(agentId, { adapterConfig }, {
        recordRevision: { createdByUserId: userId, source: "patch" },
      });
      await logActivity(tx, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "agent.updated",
        entityType: "agent",
        entityId: agentId,
        details: { adapterConfig: true, configPath, secretId: saved.id, source: "request_steps", interactionId: input.interactionId },
      });
      linkedAgentIds.push(agentId);
    }
  }
  return {
    secretId: saved.id,
    secretName: saved.name,
    linkedAgentIds,
    ...(linkingNeedsOwner ? { linkingNeedsOwner: true } : {}),
  };
}

/** The text the requesting agent wakes up with. Never carries the secret. */
export function buildStepsAgentMessage(interaction: {
  kind: string;
  status: string;
  payload?: unknown;
  result?: unknown;
}): string | null {
  if (interaction.kind !== "request_steps") return null;
  const payload = readObject(interaction.payload);
  const result = readObject(interaction.result);
  const title = typeof payload.title === "string" ? payload.title : "your steps";
  if (interaction.status === "rejected") {
    const reason = typeof result.reason === "string" && result.reason.trim() ? result.reason.trim() : "No reason given.";
    return [
      `The person could not do "${title}".`,
      `Their reason: ${reason}`,
      "Work out another way (simpler steps, a different person, or a different approach) and say what you will do in a comment.",
    ].join("\n");
  }
  if (interaction.status !== "accepted") return null;
  const lines = [`The person finished "${title}" and ticked every step.`];
  const secret = readObject(result.secret);
  if (typeof secret.secretId === "string") {
    lines.push(`The secret is saved in the company secrets as "${String(secret.secretName)}" (id ${secret.secretId}). You never see its value; use it by reference.`);
    const linked = Array.isArray(secret.linkedAgentIds) ? secret.linkedAgentIds : [];
    if (linked.length > 0) lines.push(`It is linked to ${linked.length} agent${linked.length === 1 ? "" : "s"} by reference: ${linked.join(", ")}.`);
    if (secret.linkingNeedsOwner === true) lines.push("Linking it to some agents needs an owner: ask one to link it from the agent's settings.");
  }
  if (typeof payload.afterDone === "string" && payload.afterDone.trim()) lines.push(`Next: ${payload.afterDone.trim()}`);
  return lines.join("\n");
}
