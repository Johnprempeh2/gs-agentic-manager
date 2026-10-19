import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { toolConnections } from "@greatstone/db";
import {
  getAppDefinitionForUrl,
  HIGGSFIELD_PLAN_LOW_CREDITS,
  HIGGSFIELD_PLAN_URL,
  type HiggsfieldPlanStatus,
} from "@greatstone/shared";
import { unprocessable } from "../../errors.js";
import {
  downloadImage,
  ImageGenerationError,
  type FetchLike,
  type ImageGenerationInput,
  type ImageGenerationProvider,
  type ImageGenerationResult,
} from "./types.js";

// Higgsfield (your plan): the studio's pictures and clips made through the
// company's Higgsfield app connection (mcp.higgsfield.ai, signed in as the
// account holder), so they spend that account's PLAN credits rather than the
// separate pay-as-you-go API balance HIGGSFIELD_API_KEY uses.
//
// Tools used, as listed by the Higgsfield MCP server on 18 Oct 2026:
//   balance                 -> { credits, subscription_plan_type }
//   generate_image / _video with params.get_cost -> { cost: { credits } }, no job made
//   generate_image_batch / generate_video_batch -> one job per requests[] item
//   jobs_wait               -> { jobs: [{ job_id, status, result_url }], all_terminal }
//   media_upload            -> { uploads: [{ upload_url, media_id }] }, then PUT, then
//   media_confirm           (the picture to animate)
// Every generation passes use_unlim: false, so it spends credits and never
// stops to ask about free-trial generations.

const LABEL = "Higgsfield";
export const HIGGSFIELD_PLAN_IMAGE_MODEL = "soul_2";
const COST_CACHE_MS = 10 * 60_000;
const SETTING_KEY = "studioAgentsMaySpend";

export type CallPlanTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function outOfCredits() {
  return new ImageGenerationError(
    `Your Higgsfield plan has run out of credits. Top up or upgrade at ${HIGGSFIELD_PLAN_URL}, then try again.`,
    "credits",
  );
}

/** A failure Higgsfield described, in words safe to show. Raw provider text is never passed on. */
function planError(text: string): ImageGenerationError {
  if (/credit|insufficient|balance|top.?up|upgrade/i.test(text)) return outOfCredits();
  if (/nsfw|content polic|moderat|not allowed|unsafe/i.test(text)) {
    return new ImageGenerationError(`${LABEL} declined this description under its content rules. Try describing it differently.`, "rejected");
  }
  if (/rate|too many|busy/i.test(text)) {
    return new ImageGenerationError(`${LABEL} is busy right now. Wait a minute and try again.`, "rate_limited");
  }
  return new ImageGenerationError(`${LABEL} could not do that. Please try again.`, "provider_error");
}

/** Reads a tools/call result: structured content when given, else the JSON in its first text block. */
export function planToolPayload(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  const text = (Array.isArray(record.content) ? record.content : [])
    .map(asRecord)
    .find((block) => block.type === "text" && typeof block.text === "string")?.text as string | undefined;
  if (record.isError === true) throw planError(text ?? "");
  if (record.structuredContent && typeof record.structuredContent === "object") return asRecord(record.structuredContent);
  try {
    return asRecord(JSON.parse(text ?? ""));
  } catch {
    throw new ImageGenerationError(`${LABEL} sent a reply GSAM could not read. Please try again.`, "provider_error");
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return [record.message, record.error, record.code, record.reason].filter((item) => typeof item === "string").join(" ");
}

export interface HiggsfieldPlanClientOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function higgsfieldPlanClient(callTool: CallPlanTool, options: HiggsfieldPlanClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const costs = new Map<string, { credits: number | null; expires: number }>();

  async function call(name: string, args: Record<string, unknown>) {
    try {
      return planToolPayload(await callTool(name, args));
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError(`${LABEL} could not be reached through your connected app. Check it under Apps and try again.`, "provider_error");
    }
  }

  return {
    async balance(): Promise<{ credits: number | null; planType: string | null }> {
      const body = await call("balance", {});
      return {
        credits: typeof body.credits === "number" ? body.credits : null,
        planType: typeof body.subscription_plan_type === "string" ? body.subscription_plan_type : null,
      };
    },

    /** Credits one generation would take, from Higgsfield's own price check (no job is made). */
    async cost(tool: "generate_image" | "generate_video", params: Record<string, unknown>): Promise<number | null> {
      const key = `${tool}:${JSON.stringify(params)}`;
      const cached = costs.get(key);
      if (cached && cached.expires > now()) return cached.credits;
      const body = await call(tool, { params: { ...params, get_cost: true, use_unlim: false } }).catch(() => ({}) as Record<string, unknown>);
      const credits = asRecord(asRecord(body).cost).credits;
      const value = typeof credits === "number" ? credits : null;
      costs.set(key, { credits: value, expires: now() + COST_CACHE_MS });
      return value;
    },

    /** Starts one generation and answers its job id. */
    async submit(tool: "generate_image_batch" | "generate_video_batch", params: Record<string, unknown>): Promise<string> {
      const body = await call(tool, { requests: [{ index: 0, params: { ...params, use_unlim: false } }] });
      const job = asRecord((Array.isArray(body.jobs) ? body.jobs : [])[0]);
      const jobId = job.job_id ?? job.id ?? body.job_id ?? (Array.isArray(body.job_ids) ? body.job_ids[0] : undefined);
      if (typeof jobId === "string" && jobId) return jobId;
      const failure = errorText(job.error) || errorText(asRecord((Array.isArray(body.errors) ? body.errors : [])[0])) || errorText(body.error);
      throw failure ? planError(failure) : new ImageGenerationError(`${LABEL} did not start the job. Please try again.`, "provider_error");
    },

    /** Waits for a job to finish and answers where its result can be downloaded. */
    async wait(jobId: string, timeoutMs: number): Promise<string> {
      const deadline = now() + timeoutMs;
      while (true) {
        const body = await call("jobs_wait", { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 15 });
        const job = asRecord((Array.isArray(body.jobs) ? body.jobs : []).map(asRecord).find((item) => item.job_id === jobId));
        const status = typeof job.status === "string" ? job.status : "";
        if (status === "completed") {
          if (typeof job.result_url === "string" && job.result_url) return job.result_url;
          throw new ImageGenerationError(`${LABEL} finished without returning a result. Please try again.`, "provider_error");
        }
        if (status === "nsfw") throw planError("nsfw");
        if (["failed", "canceled", "cancelled", "error"].includes(status) || (body.all_terminal === true && status !== "completed")) {
          throw planError(errorText(job.error) || status);
        }
        if (now() > deadline) throw new ImageGenerationError(`${LABEL} took too long. Please try again.`, "timeout");
        const after = typeof body.poll_after_seconds === "number" ? body.poll_after_seconds : 0;
        if (after > 0) await sleep(Math.min(after, 15) * 1000);
      }
    },

    /** Sends a picture to Higgsfield storage and answers its media id, for animating it. */
    async uploadImage(image: { bytes: Buffer; contentType: string }): Promise<string> {
      const extension = image.contentType === "image/jpeg" ? "jpg" : image.contentType === "image/webp" ? "webp" : "png";
      const body = await call("media_upload", { filename: `studio-image.${extension}`, content_type: image.contentType });
      const upload = asRecord((Array.isArray(body.uploads) ? body.uploads : [body])[0]);
      if (typeof upload.upload_url !== "string" || typeof upload.media_id !== "string") {
        throw new ImageGenerationError(`${LABEL} did not give GSAM somewhere to send the picture. Please try again.`, "provider_error");
      }
      const put = await fetchImpl(upload.upload_url, {
        method: "PUT",
        // The upload link is signed for these two headers.
        headers: { "content-type": image.contentType, "if-none-match": "*" },
        body: new Uint8Array(image.bytes),
      });
      if (!put.ok) throw new ImageGenerationError("The picture could not be sent to Higgsfield. Please try again.", "provider_error");
      await call("media_confirm", { media_id: upload.media_id, type: "image" });
      return upload.media_id;
    },

    fetchImpl,
  };
}

export type HiggsfieldPlanClient = ReturnType<typeof higgsfieldPlanClient>;

export function createHiggsfieldPlanImageProvider(
  client: HiggsfieldPlanClient,
  options: { model?: string; timeoutMs?: number } = {},
): ImageGenerationProvider {
  const model = options.model?.trim() || HIGGSFIELD_PLAN_IMAGE_MODEL;
  return {
    id: "higgsfield_plan",
    model,
    async generate({ prompt, aspectRatio, signal }: ImageGenerationInput): Promise<ImageGenerationResult> {
      const jobId = await client.submit("generate_image_batch", { model, prompt, aspect_ratio: aspectRatio });
      const url = await client.wait(jobId, options.timeoutMs ?? 5 * 60_000);
      return { image: await downloadImage(client.fetchImpl, url, signal), providerRequestId: jobId };
    },
  };
}

/** The company's connected Higgsfield app, ready to spend its plan. */
export interface HiggsfieldPlan {
  connectionId: string;
  agentsMaySpend: boolean;
  client: HiggsfieldPlanClient;
}

export type ResolveHiggsfieldPlan = (companyId: string) => Promise<HiggsfieldPlan | null>;

type ConnectionRow = typeof toolConnections.$inferSelect;

function isHiggsfieldConnection(row: ConnectionRow) {
  if (row.config.sourceTemplateKey === "higgsfield") return true;
  const url = row.config.url ?? row.config.endpoint ?? row.config.remoteUrl;
  return typeof url === "string" && getAppDefinitionForUrl(url)?.slug === "higgsfield";
}

/** The active Higgsfield app connection for a company, or null. */
export async function findHiggsfieldConnection(db: Db, companyId: string): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(
      and(
        eq(toolConnections.companyId, companyId),
        eq(toolConnections.status, "active"),
        eq(toolConnections.transport, "mcp_remote"),
      ),
    );
  return rows.find(isHiggsfieldConnection) ?? null;
}

export type CallConnectionTool = (input: {
  companyId: string;
  connectionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  actor?: { actorType: "system"; actorId: string };
}) => Promise<unknown>;

/**
 * Finds the plan for a company. Calls go through the tool access service's
 * board-side MCP client, so the connection's own OAuth grant is used and
 * refreshed there.
 */
export function higgsfieldPlanResolver(
  db: Db,
  options: { callConnectionTool?: CallConnectionTool; client?: HiggsfieldPlanClientOptions } = {},
): ResolveHiggsfieldPlan {
  let callConnectionTool = options.callConnectionTool;
  const clients = new Map<string, HiggsfieldPlanClient>();
  return async (companyId) => {
    const row = await findHiggsfieldConnection(db, companyId);
    if (!row) return null;
    if (!callConnectionTool) {
      const { toolAccessService } = await import("../tool-access.js");
      callConnectionTool = toolAccessService(db).callConnectionTool;
    }
    const call = callConnectionTool;
    let client = clients.get(row.id);
    if (!client) {
      client = higgsfieldPlanClient(
        (toolName, args) =>
          call({ companyId, connectionId: row.id, toolName, arguments: args, actor: { actorType: "system", actorId: "studio" } }),
        options.client,
      );
      clients.set(row.id, client);
    }
    return { connectionId: row.id, agentsMaySpend: row.config[SETTING_KEY] === true, client };
  };
}

/** Board setting: may agents spend the plan? Kept on the connection, which is what spends. */
export async function setHiggsfieldPlanAgentsMaySpend(db: Db, companyId: string, agentsMaySpend: boolean) {
  const row = await findHiggsfieldConnection(db, companyId);
  if (!row) throw unprocessable("Connect the Higgsfield app first, under Apps.", { code: "higgsfield_plan_not_connected" });
  await db
    .update(toolConnections)
    .set({ config: { ...row.config, [SETTING_KEY]: agentsMaySpend }, updatedAt: new Date() })
    .where(and(eq(toolConnections.id, row.id), eq(toolConnections.companyId, companyId)));
  return { agentsMaySpend };
}

/** Balance and spending setting for the studio; credits are null when Higgsfield would not say. */
export async function describeHiggsfieldPlan(plan: HiggsfieldPlan): Promise<HiggsfieldPlanStatus> {
  const balance = await plan.client.balance().catch(() => ({ credits: null, planType: null }));
  return {
    connectionId: plan.connectionId,
    credits: balance.credits,
    planType: balance.planType,
    lowCredits: balance.credits !== null && balance.credits < HIGGSFIELD_PLAN_LOW_CREDITS,
    agentsMaySpend: plan.agentsMaySpend,
    planUrl: HIGGSFIELD_PLAN_URL,
  };
}

/**
 * Picks the cloud service for one request. Left to choose, the studio uses the
 * plan when it is connected; an agent uses it only when the board allows
 * agents to spend it, and otherwise falls back to the server's API key
 * service. A null provider means no cloud service fits: the caller tries this
 * PC next.
 */
export function pickStudioProvider<P extends { id: string }>(input: {
  requested: string | undefined;
  envProvider: P | null;
  plan: HiggsfieldPlan | null;
  planProvider: (plan: HiggsfieldPlan) => P;
  isAgent: boolean;
  kind: "image" | "video";
}): { provider: P | null; plan: HiggsfieldPlan | null } {
  const { requested, envProvider, plan, isAgent } = input;
  // Practice mode is a deliberate server choice, so the plan is never picked over it unasked.
  const usePlan =
    requested === "higgsfield_plan" ||
    (!requested && !!plan && envProvider?.id !== "mock" && (!isAgent || plan.agentsMaySpend));
  if (usePlan) {
    if (!plan) {
      throw unprocessable("Higgsfield (your plan) needs the Higgsfield app. Connect it under Apps.", {
        code: "higgsfield_plan_not_connected",
      });
    }
    return { provider: input.planProvider(plan), plan };
  }
  if (requested && envProvider?.id !== requested) {
    throw unprocessable(`That ${input.kind} service is not set up. Ask your admin, or pick another one.`, {
      code: `${input.kind}_generation_not_configured`,
    });
  }
  return { provider: envProvider, plan: null };
}

/** Stops agents the board has not allowed, and any request the plan cannot pay for. */
export async function assertPlanCanSpend(plan: HiggsfieldPlan, isAgent: boolean, cost: number | null) {
  if (isAgent && !plan.agentsMaySpend) {
    throw unprocessable("Agents may not spend the Higgsfield plan. A board member can allow it in the studio.", {
      code: "higgsfield_plan_agents_off",
    });
  }
  const balance = await plan.client.balance().catch(() => null);
  const credits = balance?.credits ?? null;
  if (credits !== null && (credits <= 0 || (cost !== null && credits < cost))) {
    throw unprocessable(outOfCredits().message, { code: "higgsfield_plan_no_credits", planUrl: HIGGSFIELD_PLAN_URL, credits, cost });
  }
}
