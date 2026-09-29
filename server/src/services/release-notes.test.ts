import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReleaseNoteEntry, parseReleaseNotes, readReleaseNotes } from "./release-notes.js";

const FULL = `Decisions in the sidebar and RAM-aware run limits

Features
- Usage-based run limits recommendation with Apply (#49, GRE-117)
- Decisions always shown in the sidebar (#31, GRE-66)

Fixes
- Flag a blocked issue (#41, GRE-72)
`;

describe("parseReleaseNotes", () => {
  it("reads the title and both groups", () => {
    expect(parseReleaseNotes(FULL, "rc-2026-09-28.1")).toEqual({
      tag: "rc-2026-09-28.1",
      title: "Decisions in the sidebar and RAM-aware run limits",
      annotated: true,
      features: [
        { summary: "Usage-based run limits recommendation with Apply", pr: 49, issue: "GRE-117" },
        { summary: "Decisions always shown in the sidebar", pr: 31, issue: "GRE-66" },
      ],
      fixes: [{ summary: "Flag a blocked issue", pr: 41, issue: "GRE-72" }],
    });
  });

  it("gives an empty group when a group is missing", () => {
    const onlyFixes = parseReleaseNotes("Small fixes\n\nFixes\n- Flag a blocked issue (#41, GRE-72)\n");
    expect(onlyFixes.title).toBe("Small fixes");
    expect(onlyFixes.features).toEqual([]);
    expect(onlyFixes.fixes).toHaveLength(1);

    const noGroups = parseReleaseNotes("Release candidate rc-2026-09-27.2\n");
    expect(noGroups).toMatchObject({ title: "Release candidate rc-2026-09-27.2", features: [], fixes: [], annotated: true });
  });

  it("accepts markdown headings and ignores text outside a group and a signature", () => {
    const notes = parseReleaseNotes(
      "Title\n\nSome words.\n- not in a group\n\n## Features:\n* One (#1)\n\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n",
    );
    expect(notes.features).toEqual([{ summary: "One", pr: 1, issue: null }]);
    expect(notes.fixes).toEqual([]);
  });

  it("falls back to the tag name for a lightweight tag", () => {
    expect(parseReleaseNotes(null, "live-2026-09-27.1")).toEqual({
      tag: "live-2026-09-27.1", title: "live-2026-09-27.1", features: [], fixes: [], annotated: false,
    });
    expect(parseReleaseNotes("  \n", "rc-1").title).toBe("rc-1");
  });
});

describe("parseReleaseNoteEntry", () => {
  it("keeps brackets that are not references", () => {
    expect(parseReleaseNoteEntry("Run limits (RAM aware)")).toEqual({ summary: "Run limits (RAM aware)", pr: null, issue: null });
    expect(parseReleaseNoteEntry("Run limits (GRE-117)")).toEqual({ summary: "Run limits", pr: null, issue: "GRE-117" });
  });
});

describe("readReleaseNotes", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "gs-release-notes-"));
    git("init", "--quiet");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "start");
    git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "tag.gpgsign=false", "tag", "-a", "rc-2026-09-28.1", "-m", FULL);
    git("tag", "live-2026-09-27.1");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reads an annotated tag, a lightweight tag and an unknown tag", () => {
    expect(readReleaseNotes(repo, "rc-2026-09-28.1")?.features).toHaveLength(2);
    expect(readReleaseNotes(repo, "live-2026-09-27.1")).toMatchObject({ title: "live-2026-09-27.1", annotated: false });
    expect(readReleaseNotes(repo, "rc-1999-01-01.1")).toBeNull();
  });
});
