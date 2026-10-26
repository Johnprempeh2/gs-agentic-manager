// Redaction before retain (GRE-2668). Runs on John's Mac before anything is
// sent to GSAM. Each match is replaced with `[redacted:<type>]`; the values are
// never logged, only the type names and counts. The GSAM gateway refuses what
// still matches its own list (server/src/services/memory-gateway/sensitive-content.ts)
// and Hindsight's Memory Defense is the third layer.

/** Files never read or sent, whatever their content. */
export const NEVER_STORE_FILES = [
  /(^|\/)pilot01\.create-output\.txt$/i,
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)[^/]*\.(pem|key|p12|pfx|keychain|kdbx)$/i,
  /(^|\/)[^/]*(secret|credential|password|token)[^/]*$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
];

/** File names that, when a turn mentions them, drop every code block in that turn. */
const NEVER_STORE_MENTIONS = [/pilot01\.create-output\.txt/i, /(^|[\s/`'"])\.env(\.[a-z]+)?\b/i];

export function isNeverStoreFile(path) {
  return NEVER_STORE_FILES.some((pattern) => pattern.test(path));
}

const edge = (body, flags = "g") => new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, flags);

// Order matters: whole blocks first, then named token formats, then the generic rules.
const TOKEN_PATTERNS = [
  ["anthropic_key", edge("sk-ant-[A-Za-z0-9_-]{20,}")],
  ["openai_key", edge("sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}")],
  ["google_api_key", edge("AIza[0-9A-Za-z_-]{35}")],
  ["aws_access_key", edge("(?:AKIA|ASIA)[0-9A-Z]{16}")],
  ["github_token", edge("gh[pousr]_[A-Za-z0-9]{36,}")],
  ["github_token", edge("github_pat_[A-Za-z0-9_]{60,}")],
  ["gitlab_token", edge("glpat-[A-Za-z0-9_-]{20,}")],
  ["npm_token", edge("npm_[A-Za-z0-9]{30,}")],
  ["slack_token", edge("xox[abposr]-[0-9A-Za-z-]{10,}")],
  ["slack_webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ["stripe_key", edge("(?:[srp]k|rk)_(?:live|test)_[A-Za-z0-9]{20,}")],
  ["stripe_webhook_secret", edge("whsec_[A-Za-z0-9]{20,}")],
  ["hindsight_key", edge("hsk_(?:sys_)?[0-9a-f]{32}(?:_[0-9a-f]{8,})?")],
  ["gsam_key", edge("pcp_[A-Za-z0-9]{20,}")],
  ["netlify_token", edge("nfp_[A-Za-z0-9]{20,}")],
  ["tailscale_key", edge("tskey-[a-z]+-[A-Za-z0-9-]{10,}")],
  ["supabase_key", edge("sb(?:p|_secret)_[A-Za-z0-9_]{20,}")],
  ["huggingface_token", edge("hf_[A-Za-z0-9]{30,}")],
  ["sendgrid_key", edge("SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}")],
  ["jwt", edge("eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}")],
];

const SECRET_NAME =
  "(?:password|passwd|pwd|passphrase|pass|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|" +
  "access[_-]?token|auth[_-]?token|refresh[_-]?token|token|private[_-]?key|credentials?|cookie|session[_-]?id|signature)";

/** Values that are safe to keep in an env-style line. */
const BENIGN_ENV_VALUE = /^(?:true|false|yes|no|on|off|null|none|\d{1,6}|production|development|test|staging|local|info|debug|warn|error)$/i;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CARD_CANDIDATE = /(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d]|\.\d)/g;

function isLuhnCard(candidate) {
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

function shannonBitsPerChar(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long random-looking string: 32+ chars, upper, lower and digits, high entropy, not a path or a word chain. */
function looksLikeRandomSecret(token) {
  if (token.length < 32) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  if (/^[0-9a-f-]+$/i.test(token)) return false; // hex: git ids, hashes, UUIDs
  if ((token.match(/[A-Za-z]{3,}-/g) ?? []).length >= 3) return false; // branch-name-like word chains
  return shannonBitsPerChar(token) >= 4.2;
}

/**
 * Returns the text with secrets replaced, and the types found (never values).
 * `found` counts each type once per call.
 */
export function redact(input) {
  let text = String(input ?? "");
  const found = new Set();
  const mark = (type) => {
    found.add(type);
    return `[redacted:${type}]`;
  };

  // 1. Turns that mention a never-store file lose every code block.
  if (NEVER_STORE_MENTIONS.some((pattern) => pattern.test(text))) {
    text = text.replace(/```[\s\S]*?(```|$)/g, () => mark("never_store_file_block"));
  }

  // 2. Private key blocks, whole (a cut-off block is removed to the end of its base64 lines).
  text = text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    () => mark("private_key"),
  );

  // 3. Credentials inside URLs: scheme://user:password@host and secret query values.
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s/@]+@/gi, (_m, scheme) => `${scheme}${mark("url_credentials")}@`);
  text = text.replace(
    /([?&](?:access_token|refresh_token|token|api_key|apikey|key|secret|password|sig|signature|code)=)[^&\s#]+/gi,
    (_m, name) => `${name}${mark("url_secret")}`,
  );

  // 4. Named token formats.
  for (const [type, pattern] of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => mark(type));
  }

  // 5. Authorization headers and bearer tokens.
  text = text.replace(/\b(authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, (_m, name) => `${name}${mark("authorization_header")}`);
  text = text.replace(/\b(bearer|basic|token)\s+(?!\[redacted)([A-Za-z0-9._~+/=-]{16,})/gi, (_m, word) => `${word} ${mark("bearer_token")}`);

  // 6. .env style lines: NAME=value, `export NAME=value`. Every value but obvious settings.
  text = text.replace(/^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*[ \t]*=[ \t]*)(.*)$/gm, (line, head, value) => {
    const bare = value.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (bare === "" || BENIGN_ENV_VALUE.test(bare) || bare.startsWith("[redacted:")) return line;
    return `${head}${mark("env_value")}`;
  });

  // 7. Secret assignments in prose, code and JSON: password: x, "api_key": "x", token = 'x'.
  const assignment = new RegExp(
    `((?:["']?)\\b[A-Za-z0-9_.-]*${SECRET_NAME}["']?\\s*[:=]\\s*)("[^"\\n]{3,}"|'[^'\\n]{3,}'|[^\\s,;}\\]]{3,})`,
    "gi",
  );
  text = text.replace(assignment, (match, head, value) => {
    if (value.includes("[redacted:") || /^["']?(?:true|false|null|undefined|\$\{?[A-Z_]+\}?)["']?$/i.test(value)) return match;
    return `${head}${mark("secret_value")}`;
  });
  text = text.replace(/\b(password|passcode|pin|passphrase)(\s+(?:is|was|=|:)\s+)(\S{3,})/gi, (match, name, glue, value) =>
    value.startsWith("[redacted:") ? match : `${name}${glue}${mark("secret_value")}`,
  );

  // 8. Card numbers (Luhn), with UUIDs set aside so issue ids are never taken for cards.
  const uuids = [];
  text = text.replace(UUID, (uuid) => `\u0000${uuids.push(uuid) - 1}\u0000`);
  text = text.replace(CARD_CANDIDATE, (candidate) => (isLuhnCard(candidate) ? mark("card_number") : candidate));
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, index) => uuids[Number(index)]);

  // 9. Phone numbers the gateway refuses (UK mobile) and Ghana numbers in international form.
  text = text.replace(/(?<![\d+])(?:\+44\s?7\d{3}|07\d{3})\s?\d{3}\s?\d{3}(?!\d)/g, () => mark("phone"));
  text = text.replace(/(?<![\d+])\+233\s?\d{2}\s?\d{3}\s?\d{4}(?!\d)/g, () => mark("phone"));

  // 10. Anything else long and random-looking.
  text = text.replace(/(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_+/=-])/g, (token) =>
    looksLikeRandomSecret(token) ? mark("high_entropy_string") : token,
  );

  return { text, found: [...found].sort() };
}
