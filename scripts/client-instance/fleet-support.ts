// Support ticket bridge, host side (GRE-1084). One pass:
//   1. read the outbox from the client's app (operator log-in);
//   2. send its tickets to the hub in one signed `support-sync` message;
//   3. send each file the client picked in its own signed message;
//   4. write what was sent and the hub's answer back into the app.
// The app never talks to the hub and never holds the fleet key; the hub never
// calls the spoke. Both sides check every message against the closed schemas
// in packages/shared/src/fleet-support.ts, so nothing else can pass.
//
// Pure: the HTTP calls and the signer come in as functions, so the same code
// runs in client-instance.ts and in the round-trip test.

import {
  clientSupportOutboxSchema,
  fleetSupportSyncAnswerSchema,
  type FleetSupportAttachment,
  type FleetSupportSync,
} from "../../packages/shared/src/fleet-support.js";
import { hubAnswer } from "./fleet.js";

export type HttpAnswer = { status: number; json: unknown };

export interface SupportSyncDeps {
  /** The client's app, signed in as the operator. */
  spoke: (method: "GET" | "POST", route: string, body?: unknown) => Promise<HttpAnswer>;
  /** POST to the hub. */
  hub: (route: string, body: unknown) => Promise<HttpAnswer>;
  /** A signed fleet message with a new seq (saved before it is used). */
  sign: (claims: { act: "support-sync"; support: FleetSupportSync } | { act: "support-attachment"; attachment: FleetSupportAttachment }) => string;
}

export interface SupportSyncOutcome {
  ok: boolean;
  detail: string;
  /** The hub's time of this answer: the next `since`. Null when nothing was kept. */
  since: string | null;
}

export async function runSupportSync(deps: SupportSyncDeps, since: string | null): Promise<SupportSyncOutcome> {
  const fail = (detail: string): SupportSyncOutcome => ({ ok: false, detail, since: null });

  const outboxRes = await deps.spoke("GET", "/api/instance/client-support/outbox");
  if (outboxRes.status !== 200) return fail(`app outbox returned ${outboxRes.status}`);
  const outbox = clientSupportOutboxSchema.safeParse(outboxRes.json);
  if (!outbox.success) return fail("app outbox did not match the schema; nothing sent");

  const message = deps.sign({ act: "support-sync", support: { tickets: outbox.data.tickets, since } });
  const syncRes = await deps.hub("/api/fleet/spoke/support-sync", { message });
  const syncAnswer = hubAnswer(syncRes.status, syncRes.json);
  if (!syncAnswer.ok) return fail(`support sync: ${syncAnswer.detail}`);
  const answer = fleetSupportSyncAnswerSchema.safeParse(syncRes.json);
  if (!answer.success) return fail("hub answer did not match the schema; nothing kept");

  const sentAttachments: string[] = [];
  const problems: string[] = [];
  for (const attachment of outbox.data.attachments) {
    const contentRes = await deps.spoke("GET", `/api/instance/client-support/attachments/${attachment.ref}/content`);
    const content = (contentRes.json as { content?: unknown } | null)?.content;
    if (contentRes.status !== 200 || typeof content !== "string") {
      problems.push(`file ${attachment.ref}: app returned ${contentRes.status}`);
      continue;
    }
    const res = await deps.hub("/api/fleet/spoke/support-attachment", { message: deps.sign({ act: "support-attachment", attachment }), content });
    const sent = hubAnswer(res.status, res.json);
    if (sent.ok) sentAttachments.push(attachment.ref);
    else problems.push(`file ${attachment.ref}: ${sent.detail}`);
  }

  const inboxRes = await deps.spoke("POST", "/api/instance/client-support/inbox", {
    sentTickets: outbox.data.tickets.map((t) => ({ ref: t.ref, revision: t.revision })),
    sentAttachments,
    refused: answer.data.refused,
    tickets: answer.data.tickets,
  });
  if (inboxRes.status !== 200) return fail(`app inbox returned ${inboxRes.status}; the next pass sends again`);

  const counts = `${outbox.data.tickets.length} ticket(s) and ${sentAttachments.length} file(s) sent, ${answer.data.tickets.length} update(s) back`;
  const refused = answer.data.refused.length ? `; hub refused ${answer.data.refused.length} (${[...new Set(answer.data.refused.map((r) => r.reason))].join(", ")})` : "";
  return {
    ok: problems.length === 0 && answer.data.refused.every((r) => r.reason !== "support_not_set_up"),
    detail: `${counts}${refused}${problems.length ? `; ${problems.join("; ")}` : ""}`,
    since: answer.data.at,
  };
}
