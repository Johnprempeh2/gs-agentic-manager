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
  gsInterviewDetailSchema,
  gsInterviewInsightSchema,
  gsInterviewInviteAnswerSchema,
  gsInterviewPersonSchema,
  gsInterviewRoundItemSchema,
  gsInterviewSendAnswerSchema,
  gsInterviewSummarySchema,
  gsInterviewWithdrawalSchema,
  type DeepDiveInterviewInviteStatus,
  type DeepDiveInterviewSendKind,
  type GsInterviewDetail,
  type GsInterviewInviteAnswer,
  type GsInterviewInvitePerson,
  type GsInterviewReleasedSynthesis,
  type GsInterviewPerson,
  type GsInterviewRoundItem,
  type GsInterviewRoundPayload,
  type GsInterviewSendAnswer,
  type GsInterviewSendBody,
  type GsInterviewSummary,
  type GsInterviewWithdrawal,
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
  send(scope: InterviewBridgeScope, input: GsInterviewSendBody, actor: WebsiteBridgeActor): Promise<GsInterviewSendAnswer>;
  /** `GET rounds/{roundId}/people`: status and progress only. */
  people(scope: InterviewBridgeScope, actor: WebsiteBridgeActor): Promise<GsInterviewPerson[]>;
  /** `GET rounds/{roundId}/interviews`: the interviews that may enter synthesis (GRE-2666). */
  interviews(scope: InterviewBridgeScope, actor: WebsiteBridgeActor): Promise<GsInterviewSummary[]>;
  /** `GET rounds/{roundId}/interviews/{interviewId}`: consent and insights. The raw turns are dropped while parsing. */
  interview(scope: InterviewBridgeScope, interviewId: string, actor: WebsiteBridgeActor): Promise<GsInterviewDetail>;
  /** `GET rounds/{roundId}/withdrawals`: every hard delete, oldest first, all pages. */
  withdrawals(scope: InterviewBridgeScope, actor: WebsiteBridgeActor): Promise<GsInterviewWithdrawal[]>;
  /** `GET rounds/{roundId}`: the round as the website has it, with what the client sees now (GRE-2667). */
  round(scope: InterviewBridgeScope, actor: WebsiteBridgeActor): Promise<GsInterviewRoundItem>;
  /** `POST rounds/{roundId}/synthesis/released`: the client sees it at once. Only after a person releases it. */
  releaseSynthesis(scope: InterviewBridgeScope, synthesis: GsInterviewReleasedSynthesis, actor: WebsiteBridgeActor): Promise<{ synthesisId: string; round: GsInterviewRoundItem }>;
  /** `POST rounds/{roundId}/synthesis/withdraw`: the client stops seeing it at once. */
  withdrawSynthesis(scope: InterviewBridgeScope, actor: WebsiteBridgeActor): Promise<GsInterviewRoundItem>;
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
const releaseAnswerSchema = z.object({ synthesisId: z.string(), round: z.unknown() });
const peopleAnswerSchema = z.object({ items: z.array(z.unknown()) });
const interviewAnswerSchema = z.object({ item: z.unknown() });
const withdrawalsAnswerSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.union([z.string(), z.number()]).nullable().optional() });
/** A round has a few hundred people at most; this many pages means the site is looping. */
const MAX_WITHDRAWAL_PAGES = 50;

/** Insights one by one, so one the site sends in a form GSAM does not know names itself in the error. */
function detailOf(value: unknown, what: string): GsInterviewDetail {
  const detail = parsed(gsInterviewDetailSchema, value, what);
  return { ...detail, insights: detail.insights.map((insight, index) => parsed(gsInterviewInsightSchema, insight, `${what}.insights.${index}`)) };
}

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
      return parsed(gsInterviewSendAnswerSchema, answer, "send");
    },
    async people(scope, actor) {
      const answer = await (await client(scope, "read")).interviewRead(`${base(scope)}/people`, {}, actor);
      return parsed(peopleAnswerSchema, answer, "people").items.map((item, index) => parsed(gsInterviewPersonSchema, item, `people.${index}`));
    },
    async interviews(scope, actor) {
      const answer = await (await client(scope, "read")).interviewRead(`${base(scope)}/interviews`, {}, actor);
      return parsed(peopleAnswerSchema, answer, "interviews").items.map((item, index) => parsed(gsInterviewSummarySchema, item, `interviews.${index}`));
    },
    async interview(scope, interviewId, actor) {
      const answer = await (await client(scope, "read")).interviewRead(`${base(scope)}/interviews/${encodeURIComponent(interviewId)}`, {}, actor);
      return detailOf(parsed(interviewAnswerSchema, answer, "interview").item, "interview");
    },
    async withdrawals(scope, actor) {
      const bridge = await client(scope, "read");
      const out: GsInterviewWithdrawal[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_WITHDRAWAL_PAGES; page += 1) {
        const answer = parsed(withdrawalsAnswerSchema, await bridge.interviewRead(`${base(scope)}/withdrawals`, { after, limit: "500" }, actor), "withdrawals");
        out.push(...answer.items.map((item, index) => parsed(gsInterviewWithdrawalSchema, item, `withdrawals.${index}`)));
        if (answer.nextCursor === null || answer.nextCursor === undefined || answer.items.length === 0) return out;
        after = String(answer.nextCursor);
      }
      throw new WebsiteBridgeError("bad_response", 200, `withdrawals: more than ${MAX_WITHDRAWAL_PAGES} pages`);
    },
    async round(scope, actor) {
      const answer = await (await client(scope, "read")).interviewRead(base(scope), {}, actor);
      return parsed(gsInterviewRoundItemSchema, parsed(interviewAnswerSchema, answer, "round").item, "round");
    },
    async releaseSynthesis(scope, synthesis, actor) {
      // Keyed by the body: a retry of this release writes once; a new release has a new synthesisId.
      const body = synthesis as unknown as Record<string, unknown>;
      const answer = parsed(releaseAnswerSchema, await (await client(scope, "write")).interviewWrite(`${base(scope)}/synthesis/released`, body, actor,
        interviewIdempotencyKey(scope, "synthesis-released", body)), "release");
      return { synthesisId: answer.synthesisId, round: parsed(gsInterviewRoundItemSchema, answer.round, "release.round") };
    },
    async withdrawSynthesis(scope, actor) {
      // A new key each time: a withdraw after a second release must not replay the first.
      const answer = await (await client(scope, "write")).interviewWrite(`${base(scope)}/synthesis/withdraw`, {}, actor);
      return parsed(gsInterviewRoundItemSchema, parsed(roundAnswerSchema, answer, "withdraw").round, "withdraw");
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
  /** By employee id. An invitation held by email has `userId: null` until the person joins. */
  people: Map<string, FakePerson>;
  emails: { employeeId: string; kind: "invite" | DeepDiveInterviewSendKind }[];
  /** Ended interviews, with consent, insights and the raw turns the website keeps. */
  interviews: Map<string, GsInterviewDetail & { turns: { seq: number; role: string; content: string }[] }>;
  withdrawals: GsInterviewWithdrawal[];
  /** What the client sees: the released synthesis, or null. */
  released: (GsInterviewReleasedSynthesis & { releasedAt: string }) | null;
  /** Every synthesis push and withdraw, in order, as the site received it. */
  synthesisLog: ({ kind: "released"; organisationId: string; body: GsInterviewReleasedSynthesis } | { kind: "withdrawn"; organisationId: string })[];
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
  /** Website accounts (members of the organisation) by user id, as on the site. */
  const users = new Map<string, { userId: string; email: string; name: string }>();

  function roundOf(scope: InterviewBridgeScope) {
    const round = rounds.get(scope.roundId);
    // A round under another organisation is not found, as on the site.
    if (!round || round.organisationId !== scope.organisationId) throw new WebsiteBridgeError("not_found", 404, "not_found");
    return round;
  }

  function itemOf(roundId: string, round: FakeRound): GsInterviewRoundItem {
    return { id: roundId, status: round.payload.status, joinUrl: `https://example.test/#join/${roundId.slice(0, 8)}`,
      retentionDays: round.payload.retentionDays ?? 90, readoutAt: round.payload.readoutAt ?? null, closedAt: null, deletionDate: null,
      released: round.released ? { synthesisId: round.released.synthesisId, releasedAt: round.released.releasedAt } : null };
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
      const round: FakeRound = {
        organisationId: scope.organisationId,
        payload,
        people: existing?.people ?? new Map(),
        emails: existing?.emails ?? [],
        interviews: existing?.interviews ?? new Map(),
        withdrawals: existing?.withdrawals ?? [],
        released: existing?.released ?? null,
        synthesisLog: existing?.synthesisLog ?? [],
      };
      rounds.set(scope.roundId, round);
      return itemOf(scope.roundId, round);
    },
    async invite(scope, people) {
      const round = roundOf(scope);
      if (round.payload.status !== "open") throw new WebsiteBridgeError("conflict", 409, "conflict");
      const domains = round.payload.enrol.allowedEmailDomains;
      // Checked first, so a bad item writes nothing.
      for (const person of people) {
        if (!!person.userId === !!person.email) throw new WebsiteBridgeError("bad_request", 400, "bad_request");
        if (person.userId && !users.has(person.userId)) throw new WebsiteBridgeError("bad_request", 400, "not a member of this organisation");
        if (person.email && person.portalRole !== "client_admin" && !domains.includes(person.email.split("@")[1] ?? "")) {
          throw new WebsiteBridgeError("bad_request", 400, "email domain not allowed");
        }
      }
      const invited: GsInterviewInviteAnswer["invited"] = [];
      let emailed = 0;
      for (const person of people) {
        const account = person.userId ? users.get(person.userId)! : null;
        const email = account?.email ?? person.email!;
        // The same email on the round is updated, never duplicated; naming the account links an email invitation.
        const existing = [...round.people.values()].find((p) => (account && p.userId === account.userId) || p.email === email);
        const hash = createHash("sha256").update(email).digest()[0]!;
        const employeeId = existing?.employeeId ?? `emp_${randomBytes(6).toString("hex")}`;
        round.people.set(employeeId, {
          userId: account?.userId ?? existing?.userId ?? null,
          employeeId,
          email,
          name: account?.name ?? person.name,
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
          round.emails.push({ employeeId, kind: "invite" });
          emailed += 1;
        }
        invited.push({ userId: round.people.get(employeeId)!.userId, organisationId: scope.organisationId, employeeId, outcome: existing ? "updated" : "created" });
      }
      return { invited, emailed };
    },
    async send(scope, input) {
      const round = roundOf(scope);
      if (round.payload.status !== "open") throw new WebsiteBridgeError("bad_request", 400, "bad_request");
      const named = [
        ...input.userIds.map((userId) => [...round.people.values()].find((p) => p.userId === userId)),
        ...input.employeeIds.map((employeeId) => round.people.get(employeeId)),
      ];
      if (named.length === 0 || named.length > 200 || named.some((p) => !p)) throw new WebsiteBridgeError("bad_request", 400, "bad_request");
      const due = input.kind === "resend" ? ["invited"] : ["invited", "started"];
      let emailed = 0;
      let skipped = 0;
      for (const person of new Set(named as FakePerson[])) {
        if (!due.includes(statusOf(person).status)) {
          skipped += 1;
          continue;
        }
        round.emails.push({ employeeId: person.employeeId, kind: input.kind });
        emailed += 1;
      }
      return { emailed, skipped };
    },
    async people(scope) {
      const round = roundOf(scope);
      return [...round.people.values()].map((person) => {
        const { invitedAt: _invitedAt, becomes: _becomes, ...out } = statusOf(person);
        return out;
      });
    },
    async interviews(scope) {
      return [...roundOf(scope).interviews.values()].map((detail) => ({ ...detail.interview }));
    },
    async interview(scope, interviewId) {
      const detail = roundOf(scope).interviews.get(interviewId);
      if (!detail) throw new WebsiteBridgeError("not_found", 404, "not_found");
      // As the site answers: turns included. Parsing drops them, as for the real bridge.
      return detailOf(structuredClone(detail), "interview");
    },
    async withdrawals(scope) {
      return [...roundOf(scope).withdrawals];
    },
    async round(scope) {
      return itemOf(scope.roundId, roundOf(scope));
    },
    async releaseSynthesis(scope, synthesis) {
      const round = roundOf(scope);
      if (round.synthesisLog.some((entry) => entry.kind === "released" && entry.body.synthesisId === synthesis.synthesisId)) {
        throw new WebsiteBridgeError("conflict", 409, "conflict");
      }
      // The site re-verifies each quote against the stored insights before it releases anything.
      const insights = new Map([...round.interviews.values()].flatMap((d) => d.insights.map((i) => [i.id, i] as const)));
      for (const theme of synthesis.themes) {
        if (theme.evidence_quotes.length === 0) throw new WebsiteBridgeError("bad_request", 400, `theme ${theme.theme_id} has no evidence`);
        for (const q of theme.evidence_quotes) {
          const insight = insights.get(q.insight_id);
          if (!insight || !insight.quoteEligible || !insight.evidenceQuote.toLowerCase().includes(q.quote.toLowerCase().replace(/[.!?]+$/, ""))) {
            throw new WebsiteBridgeError("bad_request", 400, `quote from ${q.insight_id} is not verbatim in an eligible insight`);
          }
        }
      }
      round.synthesisLog.push({ kind: "released", organisationId: scope.organisationId, body: structuredClone(synthesis) });
      round.released = { ...structuredClone(synthesis), releasedAt: new Date(now()).toISOString() };
      return { synthesisId: synthesis.synthesisId, round: itemOf(scope.roundId, round) };
    },
    async withdrawSynthesis(scope) {
      const round = roundOf(scope);
      round.synthesisLog.push({ kind: "withdrawn", organisationId: scope.organisationId });
      round.released = null;
      return itemOf(scope.roundId, round);
    },
  };

  return {
    ...bridge,
    /** Test and sandbox seams. */
    fake: {
      round: (roundId: string) => rounds.get(roundId) ?? null,
      setStatus(roundId: string, employeeId: string, status: DeepDiveInterviewInviteStatus) {
        const person = rounds.get(roundId)?.people.get(employeeId);
        if (person) person.status = status;
      },
      /** An existing website account, as if they had signed up before. */
      addUser(user: { userId: string; email: string; name: string }) {
        users.set(user.userId, user);
      },
      /** An ended interview, as the website stores it. */
      addInterview(roundId: string, detail: GsInterviewDetail & { turns?: { seq: number; role: string; content: string }[] }) {
        rounds.get(roundId)?.interviews.set(detail.interview.interviewId, { ...detail, turns: detail.turns ?? [] });
      },
      /** A hard delete on the website: one interview, or every interview of the person when `interviewId` is null. */
      withdraw(roundId: string, input: { userId: string | null; interviewId: string | null }) {
        const round = rounds.get(roundId);
        if (!round) return;
        for (const [id, detail] of round.interviews) {
          if (input.interviewId ? id === input.interviewId : detail.interview.userId === input.userId) round.interviews.delete(id);
        }
        round.withdrawals.push({ cursor: String(round.withdrawals.length + 1), userId: input.userId, interviewId: input.interviewId, at: new Date(now()).toISOString() });
      },
      /** The person opens the join link and makes their account: the invitation becomes theirs by user id. */
      join(roundId: string, employeeId: string, userId: string) {
        const person = rounds.get(roundId)?.people.get(employeeId);
        if (!person) return;
        person.userId = userId;
        users.set(userId, { userId, email: person.email, name: person.name });
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
