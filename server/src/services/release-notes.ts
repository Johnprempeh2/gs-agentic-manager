// Release notes from rc-*/live-* tags (GRE-120). Each candidate is an annotated
// tag made by scripts/greatstone-candidate.mjs; the release script copies its
// message into the live-* tag. The message is:
//
//   Decisions in the sidebar and RAM-aware run limits
//
//   Features
//   - Usage-based run limits recommendation with Apply (#49, GRE-117)
//
//   Fixes
//   - Flag a blocked issue (#41, GRE-72)
//
// Line 1 is the title. Either group may be missing. A lightweight tag has no
// message: its title is the tag name and both groups are empty.
import { execFileSync } from "node:child_process";

export interface ReleaseNoteEntry {
  /** The line without the leading "- " and the "(#PR, GRE-n)" suffix. */
  summary: string;
  pr: number | null;
  issue: string | null;
}

export interface ReleaseNotes {
  tag: string | null;
  title: string;
  features: ReleaseNoteEntry[];
  fixes: ReleaseNoteEntry[];
  /** False for a lightweight tag (no message). */
  annotated: boolean;
}

const HEADING = /^\s*(?:#+\s*)?(features|fixes)\s*:?\s*$/i;
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
const REFS = /\s*\(([^()]*)\)\s*$/;

export function parseReleaseNoteEntry(text: string): ReleaseNoteEntry {
  let summary = text.trim();
  let pr: number | null = null;
  let issue: string | null = null;
  const refs = summary.match(REFS);
  if (refs) {
    const parts = refs[1]!.split(",").map((p) => p.trim());
    const prPart = parts.find((p) => /^#\d+$/.test(p));
    const issuePart = parts.find((p) => /^[A-Z]{2,6}-\d+$/.test(p));
    // Only strip the brackets when they hold references, not ordinary words.
    if ((prPart || issuePart) && parts.every((p) => p === prPart || p === issuePart)) {
      pr = prPart ? Number(prPart.slice(1)) : null;
      issue = issuePart ?? null;
      summary = summary.slice(0, refs.index).trim();
    }
  }
  return { summary, pr, issue };
}

/** Parses a tag message. `message` null or empty means a lightweight tag. */
export function parseReleaseNotes(message: string | null | undefined, tag: string | null = null): ReleaseNotes {
  const text = (message ?? "").replace(/\r\n/g, "\n").replace(/\n-----BEGIN (?:PGP|SSH) SIGNATURE-----[\s\S]*$/, "");
  const lines = text.split("\n");
  const titleIndex = lines.findIndex((l) => l.trim());
  if (titleIndex < 0) return { tag, title: tag ?? "", features: [], fixes: [], annotated: false };

  const notes: ReleaseNotes = { tag, title: lines[titleIndex]!.trim(), features: [], fixes: [], annotated: true };
  let group: ReleaseNoteEntry[] | null = null;
  for (const line of lines.slice(titleIndex + 1)) {
    const heading = line.match(HEADING);
    if (heading) {
      group = heading[1]!.toLowerCase() === "features" ? notes.features : notes.fixes;
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet && group) group.push(parseReleaseNoteEntry(bullet[1]!));
    else if (line.trim()) group = null;
  }
  return notes;
}

/**
 * Reads the notes of `tag` from the git repository at `repo`. Returns null when
 * the tag does not exist. A lightweight tag gives the fallback (tag name as the
 * title, no changes).
 */
export function readReleaseNotes(repo: string, tag: string): ReleaseNotes | null {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  let type: string;
  try {
    type = run(["cat-file", "-t", `refs/tags/${tag}`]).trim();
  } catch {
    return null;
  }
  if (type !== "tag") return parseReleaseNotes(null, tag);
  return parseReleaseNotes(run(["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]), tag);
}
