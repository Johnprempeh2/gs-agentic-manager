import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
// Keep live run credentials and its launcher out of synthetic child processes.
const fixtureEnv: NodeJS.ProcessEnv = {
  PATH: (process.env.PATH ?? "").split(path.delimiter)
    .filter((entry) => entry !== process.env.GSAM_GITHUB_LAUNCHER_DIR)
    .join(path.delimiter),
  SystemRoot: process.env.SystemRoot,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
};
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {
  it.each(["repository", "command"])("uses explicit %s identity for local commits without managed credentials", async (identitySource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-identity-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root], { env: fixtureEnv });
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const env = { ...fixtureEnv, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_COMMITTER_NAME: "Host",
    }, { url: "", token: "" }), PATH: `${bin}:${fixtureEnv.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: root, env })).stdout.trim();
    // No configured identity must fail, rather than guessing the host user's.
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    await expect(git("var", "GIT_COMMITTER_IDENT")).rejects.toThrow();
    if (identitySource === "repository") {
      await git("config", "user.name", "Local Author");
      await git("config", "user.email", "local@example.test");
    }
    await git(...(identitySource === "command" ? ["-c", "user.name=Local Author", "-c", "user.email=local@example.test"] : []),
      "commit", "--allow-empty", "-m", "Local work");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Local Author <local@example.test>|Local Author <local@example.test>");
  });

  it.each(["broker-offline", "config-unwritable", "capability-rejected"])("keeps real local Git usable when %s", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root], { env: fixtureEnv });
    await exec("git", ["-C", root, "config", "user.name", "Local Author"], { env: fixtureEnv });
    await exec("git", ["-C", root, "config", "user.email", "local@example.test"], { env: fixtureEnv });
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    if (failure === "broker-offline") await new Promise<void>(resolve => server.close(() => resolve()));
    else cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const configRoot = path.join(root, "config");
    if (failure === "config-unwritable") await writeFile(configRoot, "not a directory");
    const result = await exec(path.join(bin, "git"), ["status", "--porcelain"], { cwd: root, env: {
      ...fixtureEnv, ...githubBrokerEnvironment({ GH_TOKEN: "host-must-not-leak" }, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${fixtureEnv.PATH}`,
    } });
    expect(result.stderr).toContain(failure === "broker-offline" ? "broker_transport_unavailable" : failure === "config-unwritable" ? "configuration_directory_unavailable" : "capability_rejected");
    expect(result.stderr).not.toMatch(/host-must-not-leak|private-capability/);
    await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Offline work"], { cwd: root, env: {
      ...fixtureEnv, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${fixtureEnv.PATH}`,
    } });
  });

  // A git command can outlive its run by a moment (the provider runs `git status`
  // as it exits). The refusal must say so, not just "capability_rejected".
  it.each([
    [403, { error: "Credential acquisition requires this agent's active run", code: "run_not_active" }, "this run has already ended"],
    [401, { error: "Invalid GitHub runtime capability\n\u001b[31mspoofed" }, "Invalid GitHub runtime capability"],
  ] as const)("explains a %i refusal and keeps local Git usable", async (status, body, explanation) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-refusal-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root], { env: fixtureEnv });
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const result = await exec(path.join(bin, "git"), ["status", "--porcelain"], { cwd: root, env: {
      ...fixtureEnv, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: path.join(root, "config"), PATH: `${bin}:${fixtureEnv.PATH}`,
    } });
    expect(result.stdout).toBe("?? managed/\n"); // the real git ran
    expect(result.stderr).toContain("GitHub capability_rejected (");
    expect(result.stderr).toContain(explanation);
    expect(result.stderr).toContain("continuing without managed credentials");
    expect(result.stderr).not.toMatch(/private-capability|\u001b/);
  });

  it.each(["unavailable", "absent"])("explains %s access while allowing local work without credentials", async (status) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-diagnostic-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const server = createServer((_req,res) => {
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status,reason:"In Apps, connect GitHub to supply git credentials",env:{GH_TOKEN:"must-not-be-used"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...fixtureEnv,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${fixtureEnv.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:null});
    expect(result.stderr).toContain("In Apps, connect GitHub to supply git credentials");
    expect(result.stderr).not.toMatch(/host-token|must-not-be-used|run-capability/);
  });
  it("captures each command's identity and clears host credentials when the next person has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-launcher-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, realBin, repo, path.join(bin, "gh-config")]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const identity=execFileSync('git',['var','GIT_AUTHOR_IDENT'],{encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({identity, token:process.env.GH_TOKEN ?? null, global:process.env.GIT_CONFIG_GLOBAL, config:process.env.GH_CONFIG_DIR}));
`, { mode: 0o700 });
    let user: string | null = "A", captures = 0;
    let heldCapture: (() => void) | null = null;
    let releaseCapture: (() => void) | null = null;
    const server = createServer((req, res) => {
      captures++;
      expect(req.headers.authorization).toBe("Bearer run-capability");
      const selected = user;
      res.setHeader("content-type", "application/json");
      const finish = () => res.end(JSON.stringify(selected ? { status: "available", env: {
        GH_TOKEN: `credential-${selected}`, GITHUB_TOKEN: `credential-${selected}`,
        GIT_AUTHOR_NAME: selected, GIT_AUTHOR_EMAIL: `${selected}@example.test`,
        GIT_COMMITTER_NAME: selected, GIT_COMMITTER_EMAIL: `${selected}@example.test`,
      } } : { status: "absent", env: {} }));
      if (heldCapture) { const captured = heldCapture; heldCapture = null; releaseCapture = finish; captured(); }
      else finish();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = { ...fixtureEnv, ...githubBrokerEnvironment({
      GH_TOKEN: "ambient-host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${address.port}`, token: "run-capability" }), PATH: `${bin}:${realBin}:${fixtureEnv.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Repository Author");
    await git("config", "user.email", "repository@example.test");
    await git("commit", "--allow-empty", "-m", "A");
    user = "B";
    await git("commit", "--allow-empty", "-m", "B");
    user = "A";
    await git("commit", "--allow-empty", "-m", "A again");
    expect(await git("log", "--format=%an <%ae>|%cn <%ce>" )).toBe("A <A@example.test>|A <A@example.test>\nB <B@example.test>|B <B@example.test>\nA <A@example.test>|A <A@example.test>");
    const before = captures;
    const gh = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(gh.identity).toContain("A <A@example.test>");
    expect(gh.token).toBe("credential-A");
    expect(captures - before).toBe(1); // gh's child Git retains the same capture.
    const captured = new Promise<void>(resolve => { heldCapture = resolve; });
    const operationA = exec(path.join(bin, "gh"), [], { cwd: repo, env });
    await captured;
    user = "B";
    const operationB = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    releaseCapture!();
    const completedA = JSON.parse((await operationA).stdout);
    expect(completedA.token).toBe("credential-A");
    expect(operationB.token).toBe("credential-B");
    expect(completedA.config).not.toBe(operationB.config);
    user = null;
    await git("commit", "--allow-empty", "-m", "Local identity");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Repository Author <repository@example.test>|Repository Author <repository@example.test>");
    const anonymous = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(anonymous.token).toBeNull();
    await git("config", "--unset", "user.name");
    await git("config", "--unset", "user.email");
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });

  // GRE-6168: the broker's policy narrows a token that reaches every repository.
  describe("repository policy", () => {
    const repositories = ["johnprempeh2/gs-agentic-manager", "johnprempeh2/greatstone-website"];
    async function setup(policy: unknown) {
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-policy-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const bin = path.join(root, "managed"), realBin = path.join(root, "real"), log = path.join(root, "ran.log");
      await mkdir(bin); await mkdir(realBin);
      for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
      // Fake real binaries: git answers the launcher's remote and ref lookups;
      // both record every command that actually ran.
      await writeFile(path.join(realBin, "git"), `#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2);
while (a[0] === '-C') a.splice(0, 2);
const remotes = { origin: 'https://github.com/Johnprempeh2/gs-agentic-manager.git', web: 'git@github.com:Johnprempeh2/greatstone-website.git',
  client: 'git@github.com:Johnprempeh2/client-portal.git', local: '/srv/backup.git' };
if (a[0] === 'remote' && a[1] === 'get-url') { const u = remotes[a[a.length - 1]]; if (!u) process.exit(2); console.log(u); process.exit(0); }
if (a[0] === 'ls-remote') { console.log(a[a.length - 1]); process.exit(0); }
if (a[0] === 'symbolic-ref') { console.log('feature'); process.exit(0); }
if (a[0] === 'config') process.exit(1);
if (a[0] === 'show-ref') process.exit(a[a.length - 1] === 'refs/tags/rc-2026-11-24.1' ? 0 : 1);
const config = {};
for (let i = 0; i < Number(process.env.GIT_CONFIG_COUNT || 0); i++) config[process.env['GIT_CONFIG_KEY_' + i]] = process.env['GIT_CONFIG_VALUE_' + i];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ program: 'git', args: a, followTags: config['push.followTags'] ?? null,
  repositories: process.env.GSAM_GIT_REPOSITORIES ?? null }) + '\\n');
`, { mode: 0o700 });
      await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ program: 'gh', args: process.argv.slice(2) }) + '\\n');
`, { mode: 0o700 });
      const server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "available", ...(policy === undefined ? {} : { policy }), env: {
          GH_TOKEN: "managed-token", GSAM_GIT_TOKEN: "managed-token", GSAM_GIT_REPOSITORIES: repositories.join(" "),
        } }));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      const { port } = server.address() as { port: number };
      const env = { ...fixtureEnv, ...githubBrokerEnvironment({ GSAM_GIT_REPOSITORIES: "attacker/widened" }, {
        url: `http://127.0.0.1:${port}`, token: "run-capability",
      }), GH_CONFIG_DIR: path.join(root, "config"), PATH: `${bin}:${realBin}:${fixtureEnv.PATH}` };
      const run = async (program: "git" | "gh", ...args: string[]) => {
        try {
          const result = await exec(path.join(bin, program), args, { cwd: root, env });
          return { code: 0, stderr: result.stderr };
        } catch (error) {
          const failed = error as { code?: number; stderr?: string };
          return { code: failed.code ?? 1, stderr: failed.stderr ?? "" };
        }
      };
      const ran = async () => {
        const text = await import("node:fs/promises").then(fs => fs.readFile(log, "utf8")).catch(() => "");
        return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as { program: string; args: string[]; followTags?: string | null; repositories?: string | null });
      };
      return { run, ran };
    }

    it("allows pushes and ordinary gh work on the allowed repositories", async () => {
      const { run, ran } = await setup({ repositories, allowTagPush: false });
      for (const args of [
        ["push", "origin", "feature"],
        ["push", "-u", "origin", "HEAD"],
        ["push"],
        ["-C", ".", "push", "web", "HEAD:main"],
        ["push", "local", "feature"],
      ]) expect(await run("git", ...args), args.join(" ")).toEqual({ code: 0, stderr: "" });
      for (const args of [
        ["pr", "create", "--base", "main", "--title", "Fix", "--body", "repo create"],
        ["pr", "list", "-R", "paperclipai/paperclip"],
        ["api", "repos/Johnprempeh2/gs-agentic-manager/issues/1/comments", "-f", "body=hi"],
        ["api", "graphql", "-f", "query=query { viewer { login } }"],
        ["api", "user/repos"],
      ]) expect(await run("gh", ...args), args.join(" ")).toEqual({ code: 0, stderr: "" });
      const pushes = (await ran()).filter(entry => entry.program === "git");
      expect(pushes).toHaveLength(5);
      // Only the broker's list reaches the helper; tags cannot follow behind the check.
      for (const push of pushes) expect(push).toMatchObject({ followTags: "false", repositories: repositories.join(" ") });
      expect((await ran()).filter(entry => entry.program === "gh")).toHaveLength(5);
    });

    it.each([
      ["git", ["push", "client", "feature"], "git push to johnprempeh2/client-portal is not allowed"],
      ["git", ["push", "https://github.com/Johnprempeh2/other.git", "feature"], "johnprempeh2/other"],
      ["git", ["push", "https://gitlab.com/someone/copy.git", "main"], "non-GitHub remote"],
      ["git", ["push", "--repo=client"], "client-portal"],
      ["git", ["push", "origin", "--tags"], "pushes tags"],
      ["git", ["push", "--follow-tags"], "pushes tags"],
      ["git", ["push", "origin", "rc-2026-11-24.1"], "pushes a tag"],
      ["git", ["push", "origin", "refs/tags/v1:refs/tags/v1"], "pushes a tag"],
      ["git", ["push", "origin", "tag", "v1"], "pushes a tag"],
      ["git", ["push", "origin", "--delete", "rc-2026-11-24.1"], "pushes a tag"],
      ["git", ["send-pack", "https://github.com/Johnprempeh2/client-portal.git"], "send-pack"],
      ["gh", ["repo", "create", "leak", "--public"], "gh repo create"],
      ["gh", ["repo", "fork", "Johnprempeh2/gs-agentic-manager"], "gh repo fork"],
      ["gh", ["repo", "edit", "--visibility", "public"], "--visibility"],
      ["gh", ["repo", "edit", "Johnprempeh2/client-portal", "--description", "x"], "client-portal"],
      ["gh", ["gist", "create", "notes.md"], "gh gist"],
      ["gh", ["release", "create", "v1"], "gh release create"],
      ["gh", ["auth", "token"], "prints the GitHub token"],
      ["gh", ["secret", "set", "X"], "gh secret set"],
      ["gh", ["pr", "create", "-R", "Johnprempeh2/client-portal"], "client-portal"],
      ["gh", ["api", "-X", "POST", "user/repos", "-f", "name=leak"], "writes outside the allowed repositories"],
      ["gh", ["api", "repos/Johnprempeh2/client-portal/contents/a", "-X", "PUT", "-f", "content=x"], "writes outside"],
      ["gh", ["api", "graphql", "-f", "query=mutation { createRepository(input: {name: \"x\"}) { clientMutationId } }"], "GraphQL mutation"],
    ] as const)("refuses %s %j", async (program, args, reason) => {
      const { run, ran } = await setup({ repositories, allowTagPush: false });
      const result = await run(program, ...args);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("GS Agentic Manager: refused:");
      expect(result.stderr).toContain(reason);
      expect(result.stderr).not.toContain("managed-token");
      expect(await ran()).toEqual([]); // the real command never ran
    });

    it("lets a release agent push tags to an allowed repository only", async () => {
      const { run, ran } = await setup({ repositories, allowTagPush: true });
      expect(await run("git", "push", "origin", "rc-2026-11-24.1")).toEqual({ code: 0, stderr: "" });
      expect((await run("git", "push", "client", "--tags")).stderr).toContain("client-portal");
      expect((await ran()).map(entry => entry.args)).toEqual([["push", "origin", "rc-2026-11-24.1"]]);
    });

    it("fails closed when a credential arrives without a policy", async () => {
      const { run, ran } = await setup(undefined);
      expect((await run("git", "push", "origin", "feature")).stderr).toContain("Agents may write only to: no repository");
      expect(await ran()).toEqual([]);
    });
  });
});
