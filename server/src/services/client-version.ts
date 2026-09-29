// Client "What's new" (GRE-128, design GRE-124 "Trimmed build"): the notes are
// the message of the stable-* tag on the commit this install runs, written at
// "Promote to Stable" (GRE-127). Nothing is stored in the database.
//
// A client never sees live-* changelogs, pull request or GRE numbers: with no
// stable-* tag, or notes that cannot be read or carry internal numbers, the
// answer is the version label and no notes.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientNotesProblem, LIVE_TAG_RE, STABLE_TAG_RE } from "./release-repo.js";

export interface ClientVersion {
  /** "2026-09-28.1" from the stable-* tag, else the live-* tag, else the short commit. */
  label: string | null;
  stableTag: string | null;
  /** The stable tag message; null when there is none to show. */
  notes: string | null;
}

export type GitReader = (args: string[]) => string | null;

/** Git in the checkout this server runs from; any folder inside it will do. */
export const SERVER_CHECKOUT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function gitReader(repo: string | null): GitReader {
  return (args) => {
    if (!repo) return null;
    try {
      return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
    } catch {
      return null;
    }
  };
}

function newestTag(git: GitReader, commit: string, pattern: string, re: RegExp): string | null {
  const out = git(["tag", "--points-at", commit, "--list", pattern, "--sort=-creatordate"]);
  return out?.split("\n").map((t) => t.trim()).find((t) => re.test(t)) ?? null;
}

/** Strips a signature block, like parseReleaseNotes. */
function tagMessage(git: GitReader, tag: string): string | null {
  if (git(["cat-file", "-t", `refs/tags/${tag}`]) !== "tag") return null;
  const raw = git(["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]);
  const text = (raw ?? "").replace(/\r\n/g, "\n").replace(/\n?-----BEGIN (?:PGP|SSH) SIGNATURE-----[\s\S]*$/, "").trim();
  return text || null;
}

export function readClientVersion(git: GitReader, commit: string | null): ClientVersion {
  if (!commit) return { label: null, stableTag: null, notes: null };
  const stableTag = newestTag(git, commit, "stable-*", STABLE_TAG_RE);
  if (!stableTag) {
    const liveTag = newestTag(git, commit, "live-*", LIVE_TAG_RE);
    return { label: liveTag ? liveTag.replace(/^live-/, "") : commit.slice(0, 7), stableTag: null, notes: null };
  }
  const message = tagMessage(git, stableTag);
  return {
    label: stableTag.replace(/^stable-/, ""),
    stableTag,
    notes: message && !clientNotesProblem(message) ? message : null,
  };
}
