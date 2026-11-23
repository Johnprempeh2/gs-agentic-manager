// The "Aura" company template for an outside user's own install (GRE-6096).
//
// `templates/aura/` is a company package (agentcompanies/v1): import it with
// `gsam company import <dir> --target new`. `templates/aura/instance.json`
// names the instance switches each module needs; the installer turns them on.
// Nothing in the template may come from Greatstone: `templateLeaks` is the
// check the installer runs before it packages the template.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_FEATURE_KEYS, type InstanceFeatureKey } from "../../packages/shared/src/feature-catalog.js";

export const AURA_TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "templates/aura");

/** Stands in for the feature-request address; the package build fills it in (GRE-6099). */
export const FEATURE_REQUEST_PLACEHOLDER = "FEATURE_REQUEST_ADDRESS";

/**
 * The one paragraph of John's instructions that may name Greatstone and the
 * intake address (text from GRE-6099). The leak check allows exactly this
 * line, with the placeholder or the filled-in address, and nothing else.
 */
export const FEATURE_REQUEST_PARAGRAPH =
  `**Asking Greatstone for a feature.** When the owner wants a feature or change in GS Agentic Manager itself, write a short email to \`${FEATURE_REQUEST_PLACEHOLDER}\`. Subject: "Feature request (Aura): <short summary>". Body: what the owner wants, why, and one example. Send only the request: no passwords, keys, personal data, or files. Greatstone replies to confirm receipt; John at Greatstone decides what gets built. If you cannot send mail, give the owner this text to send from their own email.`;

/** Our own agent names: none may appear in a template that leaves Greatstone. */
const OUR_AGENT_NAMES = [
  "Everest", "Bedrock", "Keystone", "Harbor", "Beacon", "Ridge", "Mica", "Flint", "Touchstone",
  "Whetstone", "Mikey", "Summit", "Lodestone",
];

const LEAK_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "Greatstone", pattern: /greatstone/i },
  { label: "agent name of ours", pattern: new RegExp(`\\b(${OUR_AGENT_NAMES.join("|")})\\b`) },
  { label: "owner's own name", pattern: /\bWill\b/ },
  { label: "email address", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { label: "issue or client code", pattern: /\b[A-Z]{2,5}-\d+\b/ },
  { label: "token or key", pattern: /\b(sk-[\w-]{8,}|ghp_\w+|github_pat_\w+|xox[bap]-[\w-]+|AKIA[0-9A-Z]{16})\b|BEGIN [A-Z ]*PRIVATE KEY/ },
  { label: "Greatstone-only skill", pattern: /\bgreatstone-[a-z]+\b/i },
  { label: "Fable model", pattern: /claude-fable/i },
  { label: "local path", pattern: /\/Users\/|~\/GSAM|\\Users\\/ },
];

export function readTemplateFiles(dir = AURA_TEMPLATE_DIR): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[path.relative(dir, full).split(path.sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

export interface TemplateLeak {
  file: string;
  line: number;
  label: string;
}

/**
 * Every line that names Greatstone, our agents, the owner, an email, an issue
 * code, a token, a Greatstone-only skill, a Fable model or a local path. The
 * one allowed exception is `FEATURE_REQUEST_PARAGRAPH`, word for word.
 */
export function templateLeaks(files: Record<string, string>, featureRequestAddress?: string): TemplateLeak[] {
  const allowed = new Set([FEATURE_REQUEST_PARAGRAPH]);
  if (featureRequestAddress) allowed.add(FEATURE_REQUEST_PARAGRAPH.split(FEATURE_REQUEST_PLACEHOLDER).join(featureRequestAddress));
  const leaks: TemplateLeak[] = [];
  for (const [file, text] of Object.entries(files)) {
    text.split("\n").forEach((raw, index) => {
      if (allowed.has(raw.trim())) return;
      for (const { label, pattern } of LEAK_PATTERNS) {
        if (pattern.test(raw)) leaks.push({ file, line: index + 1, label });
      }
    });
  }
  return leaks;
}

/** Writes the feature-request address into John's instructions. */
export function withFeatureRequestAddress(files: Record<string, string>, address: string): Record<string, string> {
  if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(address)) throw new Error("feature-request address is not an email address");
  const out: Record<string, string> = {};
  for (const [file, text] of Object.entries(files)) out[file] = text.split(FEATURE_REQUEST_PLACEHOLDER).join(address);
  return out;
}

/** The instance switches the template's modules need, from `instance.json`. */
export function templateFeaturesOn(files: Record<string, string>): InstanceFeatureKey[] {
  const instance = JSON.parse(files["instance.json"] ?? "{}") as { modules?: Record<string, string[]> };
  const keys = Object.values(instance.modules ?? {}).flat();
  const unknown = keys.filter((key) => !(INSTANCE_FEATURE_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new Error(`instance.json names unknown switches: ${unknown.join(", ")}`);
  return keys as InstanceFeatureKey[];
}
