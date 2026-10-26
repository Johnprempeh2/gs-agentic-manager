// The Parallel Interview bridge (gs-interview-v1, GRE-2665): GSAM opens a round
// on the website, invites people and reads their status. Every path is keyed by
// the website organisation id (contracts/gs-interview-v1/README.md).
//
// Two implementations: the website's signed admin bridge, and a fake that keeps
// everything in memory. The fake is used only when GSAM_INTERVIEW_BRIDGE=fake,
// until Bedrock's endpoints are live (GRE-2612). Nothing falls back to the fake
// on its own: a site without a bridge answers website_bridge_not_configured.
import { createHash, randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { websiteSite } from "@greatstone/db";
import {
  gsInterviewInviteAnswerSchema,
  gsInterviewPersonSchema,
  gsInterviewRoundItemSchema,
  type DeepDiveInterviewInviteStatus,
  type DeepDiveInterviewSendKind,
  type GsInterviewInviteAnswer,
  type GsInterviewInvitePerson,
  type GsInterviewPerson,
  type GsInterviewRoundItem,
  type GsInterviewRoundPayload,
} from "@greatstone/shared";
import { z } from "zod";
import { WebsiteBridgeError, type WebsiteBridgeActor } from "./data-bridge-client.js";
import { websiteDataBridgeService } from "./data-bridge.js";

/** Which round, on which organisation, for which GSAM company. */
export interface InterviewBridgeScope {
  companyId: string;
  organisationId: string;
  roundId: string;
}

export interface InterviewBridge {
  /** `POST rounds/{roundId}`: create or update the round. */
  pushRound(scope: InterviewBridgeScope, payload: GsInterviewRoundPayload, actor: WebsiteBridgeActor): Promise<GsInterviewRoundItem>;
  /** `POST rounds/{roundId}/invites` with `send: true`. */
  invite(scope: InterviewBridgeScope, people: GsInterviewInvitePerson[], actor: WebsiteBridgeActor): Promise<GsInterviewInviteAnswer>;
  /** `POST rounds/{roundId}/invites/send`: email the join link again, or a reminder. */
  send(scope: InterviewBridgeScope, input: { kind: DeepDiveInterviewSendKind; userIds: string[] }, actor: WebsiteBridgeActor): Promise<{ emailed: number }>;
  /** `GET rounds/{roundId}/people`: status and progress only. */
  people(scope: InterviewBridgeScope, actor: WebsiteBridgeActor): Promise<GsInterviewPerson[]>;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WebsiteBridgeError("bad_response", 200, `${what}: ${result.error.issues[0]?.path.join(".") ?? ""} ${result.error.issues[0]?.message ?? ""}`.trim());
  }
  return result.data;
}

/** The same body under the same round always gets the same key, so a retry is written once. */
export function interviewIdempotencyKey(scope: InterviewBridgeScope, what: string, body: unknown) {
  return createHash("sha256").update(`${scope.organisationId}\n${scope.roundId}\n${what}\n${JSON.stringify(body)}`).digest("base64url").slice(0, 22);
}

const roundAnswerSchema = z.object({ round: z.unknown() });
const peopleAnswerSchema = z.object({ items: z.array(z.unknown()) });
const sendAnswerSchema = z.object({ emailed: z.number().int().min(0) });

/** The website's admin bridge, on the company's one website site. */
export function websiteInterviewBridge(db: Db): InterviewBridge {
  const bridges = websiteDataBridgeService(db);

  async function client(scope: InterviewBridgeScope, capability: "read" | "write") {
    const sites = await db.select().from(websiteSite).where(eq(websiteSite.companyId, scope.companyId)).orderBy(asc(websiteSite.createdAt));
    if (sites.length !== 1) {
      throw new WebsiteBridgeError("not_configured", null, sites.length === 0 ? "this company has no website site" : "this company has more than one website site");
    }
    return bridges.client(sites[0]!, capability);
  }

  const base = (scope: InterviewBridgeScope) =>
    `organisations/${encodeURIComponent(scope.organisationId)}/rounds/${encodeURIComponent(scope.roundId)}`;

  return {
    async pushRound(scope, payload, actor) {
      const answer = await (await client(scope, "write")).interviewWrite(base(scope), payload, actor, interviewIdempotencyKey(scope, "round", payload));
      return parsed(gsInterviewRoundItemSchema, parsed(roundAnswerSchema, answer, "round").round, "round");
    },
    async invite(scope, people, actor) {
      const body = { people, send: true };
      const answer = await (await client(scope, "write")).interviewWrite(`${base(scope)}/invites`, body, actor, interviewIdempotencyKey(scope, "invites", body));
      return parsed(gsInterviewInviteAnswerSchema, answer, "invites");
    },
    async send(scope, input, actor) {
      // A new key each time: sending a reminder twice on purpose sends it twice.
      const answer = await (await client(scope, "write")).interviewWrite(`${base(scope)}/invites/send`, input, actor);
      return parsed(sendAnswerSchema, answer, "send");
    },
    async people(scope, actor) {
      const answer = await (await client(scope, "read")).interviewRead(`${base(scope)}/people`, {}, actor);
      return parsed(peopleAnswerSchema, answer, "people").items.map((item, index) => parsed(gsInterviewPersonSchema, item, `people.${index}`));
    },
  };
}

// ---------------------------------------------------------------------------
// The fake bridge: the website as GRE-2612 will build it, in memory.
// ---------------------------------------------------------------------------

interface FakePerson extends GsInterviewPerson {
  invitedAt: number;
  /** Where the fake moves them once `progressAfterMs` has passed, so the progress page has something to show. */
  becomes: DeepDiveInterviewInviteStatus;
}

interface FakeRound {
  organisationId: string;
  payload: GsInterviewRoundPayload;
  people: Map<string, FakePerson>;
  emails: { userId: string; kind: "invite" | DeepDiveInterviewSendKind }[];
}

const FAKE_PATH: DeepDiveInterviewInviteStatus[] = ["completed", "started", "completed", "invited", "abandoned", "completed", "declined"];

export interface FakeInterviewBridgeOptions {
  now?: () => number;
  /** How long a fake invitee stays Invited before moving on. Never, by default. */
  progressAfterMs?: number | null;
}

export function createFakeInterviewBridge(options: FakeInterviewBridgeOptions = {}) {
  const now = options.now ?? Date.now;
  const progressAfterMs = options.progressAfterMs ?? null;
  const rounds = new Map<string, FakeRound>();
  /** Website accounts by email, across rounds, as on the site. */
  const users = new Map<string, { userId: string; email: string; name: string }>();

  function roundOf(scope: InterviewBridgeScope) {
    const round = rounds.get(scope.roundId);
    // A round under another organisation is not found, as on the site.
    if (!round || round.organisationId !== scope.organisationId) throw new WebsiteBridgeError("not_found", 404, "not_found");
    return round;
  }

  function statusOf(person: FakePerson): FakePerson {
    if (progressAfterMs === null || person.status !== "invited" || now() - person.invitedAt < progressAfterMs) return person;
    const started = new Date(person.invitedAt + progressAfterMs).toISOString();
    const ended = person.becomes === "completed" || person.becomes === "abandoned" ? new Date(now()).toISOString() : null;
    return {
      ...person,
      status: person.becomes,
      sessionStartedAt: person.becomes === "declined" || person.becomes === "invited" ? null : started,
      sessionEndedAt: ended,
      completionScore: person.becomes === "completed" ? 0.92 : person.becomes === "started" ? 0.45 : person.becomes === "abandoned" ? 0.2 : null,
    };
  }

  const bridge: InterviewBridge = {
    async pushRound(scope, payload) {
      const existing = rounds.get(scope.roundId);
      if (existing && existing.organisationId !== scope.organisationId) throw new WebsiteBridgeError("not_found", 404, "not_found");
      if (payload.status === "open" && (payload.seatTotal <= 0 || payload.enrol.allowedEmailDomains.length === 0)) {
        throw new WebsiteBridgeError("bad_request", 400, "bad_request");
      }
      rounds.set(scope.roundId, { organisationId: scope.organisationId, payload, people: existing?.people ?? new Map(), emails: existing?.emails ?? [] });
      return { id: scope.roundId, status: payload.status, joinUrl: `https://example.test/#join/${scope.roundId.slice(0, 8)}`,
        retentionDays: payload.retentionDays ?? 90, readoutAt: payload.readoutAt ?? null, closedAt: null, deletionDate: null };
    },
    async invite(scope, people) {
      const round = roundOf(scope);
      if (round.payload.status !== "open") throw new WebsiteBridgeError("conflict", 409, "conflict");
      const domains = round.payload.enrol.allowedEmailDomains;
      const invited: GsInterviewInviteAnswer["invited"] = [];
      let emailed = 0;
      for (const person of people) {
        let user = person.userId ? [...users.values()].find((u) => u.userId === person.userId) : users.get(person.email!);
        if (person.userId && !user) throw new WebsiteBridgeError("bad_request", 400, "unknown user");
        if (person.email && person.portalRole !== "client_admin" && !domains.includes(person.email.split("@")[1] ?? "")) {
          throw new WebsiteBridgeError("bad_request", 400, "email domain not allowed");
        }
        if (!user) {
          user = { userId: `usr_${randomBytes(8).toString("hex")}`, email: person.email!, name: person.name };
          users.set(user.email, user);
        }
        const existing = round.people.get(user.userId);
        const hash = createHash("sha256").update(user.email).digest()[0]!;
        round.people.set(user.userId, {
          userId: user.userId,
          employeeId: existing?.employeeId ?? `emp_${randomBytes(6).toString("hex")}`,
          email: user.email,
          name: person.name || user.name,
          roleTitle: person.roleTitle,
          unitId: person.unitId,
          status: existing?.status ?? "invited",
          sessionStartedAt: existing?.sessionStartedAt ?? null,
          sessionEndedAt: existing?.sessionEndedAt ?? null,
          completionScore: existing?.completionScore ?? null,
          invitedAt: existing?.invitedAt ?? now(),
          becomes: FAKE_PATH[hash % FAKE_PATH.length]!,
        });
        if (!existing) {
          round.emails.push({ userId: user.userId, kind: "invite" });
          emailed += 1;
        }
        invited.push({ userId: user.userId, employeeId: round.people.get(user.userId)!.employeeId, outcome: existing ? "updated" : "created" });
      }
      return { invited, emailed };
    },
    async send(scope, input) {
      const round = roundOf(scope);
      for (const userId of input.userIds) {
        if (!round.people.has(userId)) throw new WebsiteBridgeError("not_found", 404, "not_found");
      }
      for (const userId of input.userIds) round.emails.push({ userId, kind: input.kind });
      return { emailed: input.userIds.length };
    },
    async people(scope) {
      const round = roundOf(scope);
      return [...round.people.values()].map((person) => {
        const { invitedAt: _invitedAt, becomes: _becomes, ...out } = statusOf(person);
        return out;
      });
    },
  };

  return {
    ...bridge,
    /** Test and sandbox seams. */
    fake: {
      round: (roundId: string) => rounds.get(roundId) ?? null,
      setStatus(roundId: string, userId: string, status: DeepDiveInterviewInviteStatus) {
        const person = rounds.get(roundId)?.people.get(userId);
        if (person) person.status = status;
      },
      /** An existing website account, as if they had signed up before. */
      addUser(user: { userId: string; email: string; name: string }) {
        users.set(user.email, user);
      },
    },
  };
}
export type FakeInterviewBridge = ReturnType<typeof createFakeInterviewBridge>;

/** GSAM_INTERVIEW_BRIDGE=fake: the fake, with invitees moving on after 20 seconds so the sandbox shows progress. */
export function interviewBridgeFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): InterviewBridge {
  if (env.GSAM_INTERVIEW_BRIDGE === "fake") return createFakeInterviewBridge({ progressAfterMs: 20_000 });
  return websiteInterviewBridge(db);
}
