import { z } from "zod";

// Greatstone (GRE-1743): model-backed prompt-injection checks on tool results,
// adapted from upstream 2c96f7678. Gated by the `enablePromptInjectionModelChecks`
// experimental switch; the built-in regex stays the fallback for every failure.

export const PROMPT_INJECTION_DEFAULT_MODEL = "openai/gpt-oss-safeguard-20b";
export const PROMPT_INJECTION_DEADLINE_MS = 10_000;
export const PROMPT_INJECTION_MAX_REQUEST_BYTES = 256 * 1024;
export const PROMPT_INJECTION_MAX_OUTPUT_TOKENS = 4096;
export const PROMPT_INJECTION_POLICY_VERSION = "tool-result-v1";

export const promptInjectionFindingSchema = z.enum([
  "ignore_previous_instructions",
  "reveal_system_prompt",
  "instruction_hijack",
  "secret_exfiltration",
]);
export type PromptInjectionFinding = z.infer<typeof promptInjectionFindingSchema>;

export const promptInjectionVerdictSchema = z
  .object({
    violation: z.boolean(),
    findings: z.array(promptInjectionFindingSchema).max(4),
  })
  .strict()
  .refine(
    (v) => v.violation === (v.findings.length > 0) && new Set(v.findings).size === v.findings.length,
    { message: "Findings must be unique and agree with the verdict" },
  );
export type PromptInjectionVerdict = z.infer<typeof promptInjectionVerdictSchema>;

export type PromptInjectionFallbackReason =
  | "disabled"
  | "spend_not_acknowledged"
  | "no_cost_owner"
  | "not_configured"
  | "connection_unavailable"
  | "input_too_large"
  | "input_redaction_mismatch"
  | "timeout"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "provider_failed"
  | "invalid_output";

export type PromptInjectionModelOutcome =
  | {
      status: "classified";
      violation: boolean;
      findings: PromptInjectionFinding[];
      model: string;
      policyVersion: string;
      costEventId?: string;
    }
  | { status: "unavailable" | "failed"; reason: PromptInjectionFallbackReason; model?: string; costEventId?: string };

/** Recorded on tool invocation audit rows; never holds scanned content. */
export interface PromptInjectionDetectorMetadata {
  detector: "model" | "regex";
  model?: string;
  policyVersion?: string;
  costEventId?: string;
  fallbackReason?: PromptInjectionFallbackReason;
}
