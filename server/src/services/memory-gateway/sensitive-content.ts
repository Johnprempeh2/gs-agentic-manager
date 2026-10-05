import { MEMORY_DETECTION_NOTE } from "@greatstone/shared";
import { HttpError } from "../../errors.js";

/**
 * Pattern check the gateway runs on every contribution before anything is
 * stored (GRE-868). Secrets and personal data are refused, not redacted: the
 * contributor knows what was meant and can resend without the value.
 *
 * High-confidence patterns only, close to Hindsight's Memory Defense list
 * (`hindsight_api/extensions/memory_defense.py`, v0.10.2), plus UK mobile
 * numbers, which the engine does not cover. The engine's own Memory Defense
 * stays on as a second layer (hindsight.ts).
 */

// ASCII token edges: `\b` treats CJK letters as word characters.
const token = (body: string) => new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, "g");

const PATTERNS: Array<[type: string, pattern: RegExp]> = [
  ["anthropic_key", token("sk-ant-[A-Za-z0-9_-]{20,}")],
  ["openai_key", token("sk-[A-Za-z0-9_-]{20,}")],
  ["google_api_key", token("AIza[0-9A-Za-z_-]{35}")],
  ["aws_access_key", token("(?:AKIA|ASIA)[0-9A-Z]{16}")],
  ["github_token", token("gh[pousr]_[A-Za-z0-9]{36,}")],
  ["github_fine_grained_token", token("github_pat_[A-Za-z0-9_]{60,}")],
  ["gitlab_token", token("glpat-[A-Za-z0-9_-]{20,}")],
  ["npm_token", token("npm_[A-Za-z0-9]{30,}")],
  ["slack_token", token("xox[abpr]-[0-9A-Za-z-]{10,}")],
  ["stripe_key", token("[sr]k_(?:live|test)_[A-Za-z0-9]{20,}")],
  ["hindsight_key", token("hsk_(?:sys_)?[0-9a-f]{32}(?:_[0-9a-f]{8,})?")],
  ["jwt", token("eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}")],
  ["private_key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  // Connection strings with a password in them.
  ["database_url", /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:/@]+:[^\s/@]+@\S+/gi],
  // UK mobile: 07xxx xxxxxx or +44 7xxx xxxxxx, with optional spaces.
  ["uk_phone", /(?<![\d+])(?:\+44\s?7\d{3}|07\d{3})\s?\d{3}\s?\d{3}(?!\d)/g],
];

// 13 to 19 digits, in groups split by single spaces or dashes; Luhn-checked below.
const CARD_CANDIDATE = /(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d]|\.\d)/g;

function isLuhnCard(candidate: string) {
  const digits = candidate.replace(/[ -]/g, "").split("").map(Number);
  if (new Set(digits).size === 1) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = digits[digits.length - 1 - i];
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** The pattern names found in `text`. Never the values. */
export function detectSensitiveContent(text: string): string[] {
  const found = new Set<string>();
  for (const [type, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.add(type);
  }
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    if (isLuhnCard(match[0])) {
      found.add("card_number");
      break;
    }
  }
  return [...found];
}

export const MEMORY_SENSITIVE_CONTENT_CODE = "memory_sensitive_content";

export class MemorySensitiveContentError extends HttpError {
  readonly matchedTypes: string[];

  constructor(matchedTypes: string[]) {
    // The message alone must be enough for an agent reading an MCP tool result.
    super(
      422,
      `Not stored: the contribution matches a secret or personal-data pattern (${matchedTypes.join(", ")}). ` +
        `Remove the value and send it again. ${MEMORY_DETECTION_NOTE}`,
      { code: MEMORY_SENSITIVE_CONTENT_CODE, matchedTypes, detection: MEMORY_DETECTION_NOTE },
    );
    this.matchedTypes = matchedTypes;
  }
}
