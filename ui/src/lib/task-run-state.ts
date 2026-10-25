import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@greatstone/shared";
import type { LiveRunForIssue } from "../api/heartbeats";

/**
 * What a task's agent run is doing right now, for every surface that shows run
 * state (task header, task rows, Desk, tree nodes, agent page).
 *
 * The live-runs endpoints return `queued` and `running` runs together. A queued
 * run is a wake waiting for a free slot on its agent (GRE-2246: Lintel runs 1 at
 * a time, so GRE-2019 waited behind GRE-2217). Treating both as "working" made a
 * waiting task spin. This splits them, and says why a queued run waits.
 */
export type TaskRunState = RunningTaskRunState | QueuedTaskRunState;

export interface RunningTaskRunState {
  kind: "running" | "stuck";
  runId: string;
  agentId: string;
  agentName: string;
  /** When the run started; null if the server has not stamped it yet. */
  startedAt: string | null;
  /** Last sign of output: the latest event, else the start. */
  lastOutputAt: string | null;
  /** Milliseconds since `lastOutputAt`; null when unknown. */
  silentMs: number | null;
}

export type QueuedReason =
  /** The agent is paused; the run starts when it is resumed. */
  | { kind: "agent_paused" }
  /** A release is pausing new runs (task drain). */
  | { kind: "release" }
  /** The instance is holding new runs (run cap, low memory, low disk). */
  | { kind: "instance_hold"; message: string }
  /** Every slot on the agent is busy; `blockingIssueId` is the task holding the oldest slot. */
  | { kind: "behind"; blockingIssueId: string | null; blockingRunId: string; maxConcurrentRuns: number }
  /** A slot is free; the run is about to start. */
  | { kind: "starting" };

export interface QueuedTaskRunState {
  kind: "queued";
  runId: string;
  agentId: string;
  agentName: string;
  reason: QueuedReason;
  /** 1-based place in the agent's queue (oldest first). */
  position: number;
  /** How many runs wait on this agent in total. */
  queueLength: number;
}

/** A run with no output for this long reads as stuck. */
export const STUCK_SILENCE_MS = 10 * 60 * 1000;

export interface TaskRunStateAgent {
  id: string;
  status?: string | null;
  runtimeConfig?: unknown;
}

export interface TaskRunStateContext {
  now: number;
  /** Agents by id, for the paused state and the per-agent run limit. */
  agentsById?: ReadonlyMap<string, TaskRunStateAgent> | null;
  /** True while a release pauses new runs. */
  releaseDraining?: boolean;
}

type RunInput = Pick<
  LiveRunForIssue,
  "id" | "status" | "agentId" | "agentName" | "issueId" | "createdAt" | "startedAt" | "lastEventAt" | "currentStatusMessage"
>;

function toMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The agent's own run limit, read the same way the server does (1 to 50, default 20). */
export function agentMaxConcurrentRuns(agent: TaskRunStateAgent | null | undefined): number {
  const config = agent?.runtimeConfig;
  const heartbeat =
    config && typeof config === "object" ? (config as { heartbeat?: unknown }).heartbeat : undefined;
  const raw =
    heartbeat && typeof heartbeat === "object"
      ? Number((heartbeat as { maxConcurrentRuns?: unknown }).maxConcurrentRuns)
      : Number.NaN;
  if (!Number.isFinite(raw)) return AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  return Math.min(50, Math.max(1, Math.floor(raw)));
}

const INSTANCE_HOLD_PREFIX = /^Waiting:\s*/;

function runningState(run: RunInput, now: number): RunningTaskRunState {
  const lastOutputAt = run.lastEventAt ?? run.startedAt ?? null;
  const lastMs = toMs(lastOutputAt);
  const silentMs = lastMs === null ? null : Math.max(0, now - lastMs);
  return {
    kind: silentMs !== null && silentMs >= STUCK_SILENCE_MS ? "stuck" : "running",
    runId: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    startedAt: run.startedAt ?? null,
    lastOutputAt,
    silentMs,
  };
}

/** Re-read a running state against the clock, so it can turn stuck while shown. */
export function refreshTaskRunState(state: TaskRunState, now: number): TaskRunState {
  if (state.kind === "queued") return state;
  const lastMs = toMs(state.lastOutputAt);
  const silentMs = lastMs === null ? null : Math.max(0, now - lastMs);
  const kind = silentMs !== null && silentMs >= STUCK_SILENCE_MS ? "stuck" : "running";
  if (kind === state.kind && silentMs === state.silentMs) return state;
  return { ...state, kind, silentMs };
}

function byCreatedAt(a: RunInput, b: RunInput): number {
  return (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0);
}

function byStartedAt(a: RunInput, b: RunInput): number {
  return (toMs(a.startedAt ?? a.createdAt) ?? 0) - (toMs(b.startedAt ?? b.createdAt) ?? 0);
}

function queuedReason(
  run: RunInput,
  runningForAgent: readonly RunInput[],
  context: TaskRunStateContext,
): QueuedReason {
  const agent = context.agentsById?.get(run.agentId);
  if (agent?.status === "paused") return { kind: "agent_paused" };
  if (context.releaseDraining) return { kind: "release" };
  const message = run.currentStatusMessage?.trim();
  if (message && INSTANCE_HOLD_PREFIX.test(message)) {
    return { kind: "instance_hold", message: message.replace(INSTANCE_HOLD_PREFIX, "") };
  }
  const maxConcurrentRuns = agentMaxConcurrentRuns(agent);
  if (runningForAgent.length >= maxConcurrentRuns && runningForAgent.length > 0) {
    const blocker = runningForAgent[0]!;
    return { kind: "behind", blockingIssueId: blocker.issueId ?? null, blockingRunId: blocker.id, maxConcurrentRuns };
  }
  return { kind: "starting" };
}

/**
 * Run state for every task with a queued or running run. A task with both a
 * running and a queued run shows as running.
 */
export function deriveTaskRunStates(
  liveRuns: readonly RunInput[] | null | undefined,
  context: TaskRunStateContext,
): Map<string, TaskRunState> {
  const states = new Map<string, TaskRunState>();
  const runs = liveRuns ?? [];

  const runningByAgent = new Map<string, RunInput[]>();
  const queuedByAgent = new Map<string, RunInput[]>();
  for (const run of runs) {
    const bucket = run.status === "running" ? runningByAgent : run.status === "queued" ? queuedByAgent : null;
    if (!bucket) continue;
    const list = bucket.get(run.agentId) ?? [];
    list.push(run);
    bucket.set(run.agentId, list);
  }
  for (const list of runningByAgent.values()) list.sort(byStartedAt);
  for (const list of queuedByAgent.values()) list.sort(byCreatedAt);

  for (const list of runningByAgent.values()) {
    for (const run of list) {
      if (!run.issueId || states.get(run.issueId)?.kind === "running") continue;
      states.set(run.issueId, runningState(run, context.now));
    }
  }

  for (const [agentId, queue] of queuedByAgent) {
    const runningForAgent = runningByAgent.get(agentId) ?? [];
    queue.forEach((run, index) => {
      if (!run.issueId || states.has(run.issueId)) return;
      states.set(run.issueId, {
        kind: "queued",
        runId: run.id,
        agentId: run.agentId,
        agentName: run.agentName,
        reason: queuedReason(run, runningForAgent, context),
        position: index + 1,
        queueLength: queue.length,
      });
    });
  }

  return states;
}

/** A task's run state, or null for finished and cancelled tasks (a late run there is not news). */
export function runStateForTask(
  states: ReadonlyMap<string, TaskRunState>,
  task: { id: string; status?: string | null },
): TaskRunState | null {
  if (task.status === "done" || task.status === "cancelled") return null;
  return states.get(task.id) ?? null;
}

export function deriveTaskRunState(
  issueId: string,
  liveRuns: readonly RunInput[] | null | undefined,
  context: TaskRunStateContext,
): TaskRunState | null {
  return deriveTaskRunStates(liveRuns, context).get(issueId) ?? null;
}

/**
 * "no output for 12 min" once a live run has been silent for the stuck
 * threshold, else null. For lines that sit beside the chip (activity line,
 * chat header) so they agree with it.
 */
export function runSilenceNote(lastOutputAtMs: number | null | undefined, now: number): string | null {
  if (lastOutputAtMs == null || !Number.isFinite(lastOutputAtMs)) return null;
  const silentMs = now - lastOutputAtMs;
  return silentMs >= STUCK_SILENCE_MS ? `no output for ${formatRunDuration(silentMs)}` : null;
}

/** "20s", "4 min", "1 h 5 min". Short enough for a chip. */
export function formatRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

export interface TaskRunStateCopy {
  /** Chip text: "Working", "Queued", "Waiting for release", "No output for 12 min". */
  label: string;
  /** The why or the progress, without the blocking task's identifier. */
  detail: string | null;
  /** Task the run waits behind, for a link. */
  blockingIssueId: string | null;
  /** One sentence for a tooltip or screen reader. */
  summary: string;
}

/**
 * Words for a run state. `issueLabel` turns a task id into "GRE-2217"; when it
 * cannot, the copy says "another task".
 */
export function describeTaskRunState(
  state: TaskRunState,
  options: { now: number; issueLabel?: (issueId: string) => string | null | undefined },
): TaskRunStateCopy {
  if (state.kind !== "queued") {
    const startedMs = toMs(state.startedAt);
    const elapsed = startedMs === null ? null : formatRunDuration(options.now - startedMs);
    const lastOutput = state.silentMs === null ? null : `last output ${formatRunDuration(state.silentMs)} ago`;
    if (state.kind === "stuck") {
      const silent = formatRunDuration(state.silentMs ?? 0);
      return {
        label: `No output for ${silent}`,
        detail: elapsed ? `running ${elapsed}` : null,
        blockingIssueId: null,
        summary: `${state.agentName} is running but has shown no output for ${silent}.`,
      };
    }
    const detail = [elapsed, lastOutput].filter(Boolean).join(" · ") || null;
    return {
      label: "Working",
      detail,
      blockingIssueId: null,
      summary: `${state.agentName} is working on it${detail ? ` (${detail})` : ""}.`,
    };
  }

  const position = state.queueLength > 1 ? `${ordinal(state.position)} of ${state.queueLength} waiting` : null;
  let label = "Queued";
  let why: string;
  let blockingIssueId: string | null = null;
  switch (state.reason.kind) {
    case "agent_paused":
      why = `${state.agentName} is paused`;
      break;
    case "release":
      // GRE-2274: the chip itself says it, so a held task never reads as stuck in a queue.
      label = "Waiting for release";
      why = "Starts when the release is done";
      break;
    case "instance_hold":
      why = `Waiting: ${state.reason.message}`;
      break;
    case "behind": {
      blockingIssueId = state.reason.blockingIssueId;
      const label = blockingIssueId ? options.issueLabel?.(blockingIssueId) ?? "another task" : "another task";
      const limit = state.reason.maxConcurrentRuns;
      why = `Behind ${label} (${state.agentName} runs ${limit} at a time)`;
      break;
    }
    case "starting":
      why = "Starting soon";
      break;
  }
  const detail = [why, position].filter(Boolean).join(" · ");
  return { label, detail, blockingIssueId, summary: `${label}. ${detail}.` };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
