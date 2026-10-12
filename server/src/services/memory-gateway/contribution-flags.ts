import type { MemoryContributionFlag } from "@greatstone/shared";

/**
 * Text checks run on every contribution (GRE-886 item 5, threat model D4).
 * They only mark the entry for a reviewer: the record is stored unreviewed
 * either way, and text can never approve it or grant anything. Pattern-based,
 * so they miss things and mark harmless text; callers get MEMORY_FLAG_NOTE.
 */

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|earlier|above|your)?\s*(?:instructions|rules|prompts?)\b/i,
  /\bsystem\s+(?:override|prompt)\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(?:always|from now on)\s+(?:treat|reply|answer|respond)\b/i,
  /\bexport\s+(?:all|every)\b/i,
  /\b(?:email|send|forward|post|upload)\b[^.\n]{0,80}\bto\s+\S+@\S+/i,
  /<!--[\s\S]*?-->|display\s*:\s*none/i,
];

const APPROVAL_CLAIM_PATTERNS: RegExp[] = [
  /\bI\s+(?:hereby\s+)?approve\b/i,
  /\b(?:approved|signed off|authori[sz]ed)\s+by\b/i,
  /\b(?:john|the board|the owner)\s+(?:approves|has approved|approved)\b/i,
  /^\s*(?:GRANT|APPROVED)\s*:/im,
  /\btreat\b[^.\n]{0,80}\bas\s+approved\b/i,
  /\bthis\s+(?:is|has been)\s+(?:approved|authori[sz]ed)\b/i,
];

export function detectContributionFlags(text: string): MemoryContributionFlag[] {
  const flags: MemoryContributionFlag[] = [];
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) flags.push("instruction_like_text");
  if (APPROVAL_CLAIM_PATTERNS.some((pattern) => pattern.test(text))) flags.push("claims_approval_without_record");
  return flags;
}
