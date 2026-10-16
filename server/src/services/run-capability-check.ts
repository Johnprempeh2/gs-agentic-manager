import {
  describeMissingRunCapabilities,
  probeRunCapabilities,
  type ProbeRunCapabilitiesInput,
  type RunCapabilityProbeReport,
} from "@greatstone/adapter-utils/run-capability-probe";
import { readRequiredRunCapabilities } from "@greatstone/shared";

export const REQUIRED_CAPABILITY_MISSING_REASON = "required_capability_missing";
export const RUN_CAPABILITY_CHECK_EVENT_TYPE = "capability_check";

export type RunCapabilityProbe = (input: ProbeRunCapabilitiesInput) => Promise<RunCapabilityProbeReport>;

function runEnvValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") return record.value;
  }
  return null;
}

/**
 * The environment the agent process will see, as far as the server knows it
 * before launch: the server's own environment plus the agent's resolved
 * settings. Only used to find tools (PATH, browser settings, gh sign-in).
 */
export function buildCapabilityProbeEnv(
  resolvedConfig: Record<string, unknown>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const configured = resolvedConfig.env;
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    for (const [key, value] of Object.entries(configured as Record<string, unknown>)) {
      const resolved = runEnvValue(value);
      if (resolved !== null) env[key] = resolved;
    }
  }
  return env;
}

export type RunCapabilityCheckOutcome =
  | { status: "not_declared" }
  | { status: "skipped"; required: string[]; environmentDriver: string }
  | { status: "passed" | "missing"; required: string[]; report: RunCapabilityProbeReport; message: string | null };

/**
 * Runs the declared checks for a run, or returns at once when the agent
 * declared none (no probe cost). Only local runs are checked: a sandbox or
 * remote machine has its own tools, which this server cannot see.
 */
export async function checkRequiredRunCapabilities(input: {
  resolvedConfig: Record<string, unknown>;
  environmentDriver: string | null | undefined;
  githubAccessProvidedByPlatform: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  probe?: RunCapabilityProbe;
}): Promise<RunCapabilityCheckOutcome> {
  const required = readRequiredRunCapabilities(input.resolvedConfig);
  if (required.length === 0) return { status: "not_declared" };
  const environmentDriver = input.environmentDriver ?? "local";
  if (environmentDriver !== "local") return { status: "skipped", required, environmentDriver };
  const report = await (input.probe ?? probeRunCapabilities)({
    required,
    env: buildCapabilityProbeEnv(input.resolvedConfig, input.baseEnv),
    githubAccessProvidedByPlatform: input.githubAccessProvidedByPlatform,
  });
  return {
    status: report.ok ? "passed" : "missing",
    required,
    report,
    message: report.ok ? null : describeMissingRunCapabilities(report),
  };
}

/** Run-log payload: names, results and short notes only, never env values. */
export function runCapabilityCheckEventPayload(outcome: Exclude<RunCapabilityCheckOutcome, { status: "not_declared" }>) {
  if (outcome.status === "skipped") {
    return { status: "skipped", required: outcome.required, environmentDriver: outcome.environmentDriver };
  }
  return {
    status: outcome.status,
    required: outcome.required,
    missing: outcome.report.missing,
    durationMs: outcome.report.durationMs,
    checks: outcome.report.checks.map((check) => ({
      capability: check.capability,
      ok: check.ok,
      detail: check.detail,
      durationMs: check.durationMs,
    })),
  };
}
