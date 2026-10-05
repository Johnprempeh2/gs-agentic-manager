import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySkills, createDb, projects, projectWorkspaces } from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";
import { removeRuntimeSkillCache } from "../services/runtime-skill-cache.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Shape of pbakaus/impeccable: markdown skill plus a scripts/ launcher and helpers.
const SKILL_MARKDOWN = "---\nname: impeccable\ndescription: Design skill\n---\n# Impeccable\n";
const UPSTREAM_TREE = [
  "impeccable/SKILL.md",
  "impeccable/reference/audit.md",
  "impeccable/scripts/impeccable",
  "impeccable/scripts/impeccable.cmd",
  "impeccable/scripts/live-browser.js",
  "impeccable/scripts/data/font-index.json",
];

function stubGitHub(revision: () => string) {
  const upstream = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/commits/")) return Response.json({ sha: revision() });
    if (url.includes("/git/trees/")) {
      return Response.json({ tree: UPSTREAM_TREE.map((entry) => ({ path: entry, type: "blob" })) });
    }
    if (url.endsWith("/SKILL.md")) return new Response(SKILL_MARKDOWN);
    if (url.endsWith("/reference/audit.md")) return new Response("# Audit\n");
    if (url.includes("/scripts/")) return new Response("#!/bin/sh\necho launched\n");
    return Response.json({ default_branch: "main" });
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

describeEmbeddedPostgres("company skill import with stripScripts (GRE-757)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldHome: string | undefined;
  let oldInstanceId: string | undefined;
  let home = "";
  const cleanupDirs = new Set<string>();

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Strip Co",
      issuePrefix: `S${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-import-strip-");
    db = createDb(tempDb.connectionString);
    oldHome = process.env.GSAM_HOME;
    oldInstanceId = process.env.GSAM_INSTANCE_ID;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-strip-home-"));
    process.env.GSAM_HOME = home;
    process.env.GSAM_INSTANCE_ID = "default";
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const skill of await db.select().from(companySkills)) {
      await removeRuntimeSkillCache(path.join(home, "instances", "default", "skills", skill.companyId), skill.id);
    }
    await db.delete(companySkills);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all([...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (oldHome === undefined) delete process.env.GSAM_HOME;
    else process.env.GSAM_HOME = oldHome;
    if (oldInstanceId === undefined) delete process.env.GSAM_INSTANCE_ID;
    else process.env.GSAM_INSTANCE_ID = oldInstanceId;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("imports a GitHub skill as markdown_only with scripts stripped, listed, and kept out on update", async () => {
    const companyId = await createCompany();
    let revision = "a".repeat(40);
    stubGitHub(() => revision);
    const svc = companySkillService(db);

    const result = await svc.importFromSource(companyId, "https://github.com/pbakaus/impeccable", { stripScripts: true });

    expect(result.imported).toHaveLength(1);
    const skill = result.imported[0]!;
    expect(skill.trustLevel).toBe("markdown_only");
    expect(skill.fileInventory.map((entry) => entry.path)).toEqual(["reference/audit.md", "SKILL.md"].sort((a, b) => a.localeCompare(b)));
    expect(skill.fileInventory.some((entry) => entry.kind === "script")).toBe(false);
    const expectedStripped = [
      "scripts/data/font-index.json",
      "scripts/impeccable",
      "scripts/impeccable.cmd",
      "scripts/live-browser.js",
    ];
    expect(result.strippedFiles).toEqual([{ skillKey: skill.key, slug: "impeccable", paths: expectedStripped }]);
    expect(skill.metadata).toMatchObject({ scriptsStripped: true, strippedScriptPaths: expectedStripped });
    await expect(svc.readFile(companyId, skill.id, "scripts/impeccable")).rejects.toMatchObject({ status: 404 });

    const runtime = (await svc.listRuntimeSkillEntries(companyId)).find((entry) => entry.key === skill.key)!;
    await expect(fs.stat(path.join(runtime.source, "SKILL.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(runtime.source, "scripts"))).rejects.toMatchObject({ code: "ENOENT" });

    revision = "b".repeat(40);
    const updated = await svc.installUpdate(companyId, skill.id);
    expect(updated?.sourceRef).toBe(revision);
    expect(updated?.trustLevel).toBe("markdown_only");
    expect(updated?.fileInventory.some((entry) => entry.kind === "script")).toBe(false);
  });

  it("still refuses a GitHub skill with scripts when stripScripts is not set, and names the scripts", async () => {
    const companyId = await createCompany();
    stubGitHub(() => "a".repeat(40));
    const svc = companySkillService(db);

    await expect(svc.importFromSource(companyId, "https://github.com/pbakaus/impeccable")).rejects.toMatchObject({
      status: 422,
      details: {
        reason: "scripts_executables_blocked",
        scriptPaths: expect.arrayContaining(["scripts/impeccable", "scripts/live-browser.js"]),
      },
    });
    expect((await db.select().from(companySkills)).some((row) => row.slug === "impeccable")).toBe(false);
  });

  // GRE-775: a URL that points straight at the skill folder must see the same
  // files as the parent-folder URL, not just SKILL.md.
  it("gives a skill-folder GitHub URL the same inventory as the parent-folder URL", async () => {
    const companyId = await createCompany();
    stubGitHub(() => "a".repeat(40));
    const svc = companySkillService(db);
    const folderUrl = "https://github.com/pbakaus/impeccable/tree/main/impeccable";

    await expect(svc.importFromSource(companyId, folderUrl)).rejects.toMatchObject({
      status: 422,
      details: {
        reason: "scripts_executables_blocked",
        scriptPaths: expect.arrayContaining(["scripts/impeccable", "scripts/live-browser.js"]),
      },
    });

    const fromFolder = await svc.importFromSource(companyId, folderUrl, { stripScripts: true });
    const folderSkill = fromFolder.imported[0]!;
    expect(folderSkill.slug).toBe("impeccable");
    expect(folderSkill.trustLevel).toBe("markdown_only");
    expect(folderSkill.metadata).toMatchObject({ repoSkillDir: "impeccable" });
    expect(fromFolder.strippedFiles[0]?.paths).toHaveLength(4);
    await expect(svc.readFile(companyId, folderSkill.id, "reference/audit.md")).resolves.toMatchObject({
      content: "# Audit\n",
    });

    const fromParent = await svc.importFromSource(companyId, "https://github.com/pbakaus/impeccable", { stripScripts: true });
    expect(fromParent.imported[0]!.fileInventory).toEqual(folderSkill.fileInventory);
    expect(fromParent.strippedFiles[0]?.paths).toEqual(fromFolder.strippedFiles[0]?.paths);
  });

  it("still refuses local paths outside approved roots, including traversal, even with stripScripts", async () => {
    const companyId = await createCompany();
    const projectId = randomUUID();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-strip-workspace-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-strip-outside-"));
    cleanupDirs.add(workspace);
    cleanupDirs.add(outside);
    await fs.writeFile(path.join(outside, "SKILL.md"), SKILL_MARKDOWN, "utf8");
    await db.insert(projects).values({ id: projectId, companyId, name: "Approved project" });
    await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Primary", cwd: workspace, isPrimary: true });
    const svc = companySkillService(db);

    await expect(svc.importFromSource(companyId, outside, { stripScripts: true })).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_workspace_boundary_denied" },
    });
    const traversal = path.join(workspace, "..", path.basename(outside));
    await expect(svc.importFromSource(companyId, traversal, { stripScripts: true })).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_workspace_boundary_denied" },
    });
    expect((await db.select().from(companySkills)).some((row) => row.slug === "impeccable")).toBe(false);
  });
});
