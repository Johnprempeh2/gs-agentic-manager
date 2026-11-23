// HTTP checks of a fresh Aura install (GRE-6097), run by
// scripts/aura-macos/smoke-test.sh on a macOS runner. Never on a real install:
// it makes test log-ins.
//
//   node smoke-test.mjs first-run <url> <server.log> <state file>
//   node smoke-test.mjs invite    <url> <state file>

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [phase, base, ...rest] = process.argv.slice(2);
let failed = 0;
const check = (ok, line) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  if (!ok) failed += 1;
};
const must = (ok, line) => {
  check(ok, line);
  if (!ok) process.exit(1);
};

class Session {
  cookies = new Map();
  async request(method, route, body, headers = {}) {
    const h = { Origin: base, Accept: "application/json", ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${base}${route}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  }
}

const list = (json, key) => (Array.isArray(json) ? json : Array.isArray(json?.[key]) ? json[key] : []);

if (phase === "first-run") {
  const [logFile, stateFile] = rest;
  const health = (await new Session().request("GET", "/api/health")).json;
  must(health?.status === "ok", "server healthy");
  check(health?.deploymentMode === "authenticated", `authenticated mode (${health?.deploymentMode})`);
  check(health?.deploymentExposure === undefined || health?.deploymentExposure === "private", `private exposure (${health?.deploymentExposure ?? "not reported"})`);

  const log = readFileSync(logFile, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  const links = [...log.matchAll(/http:\/\/[^\s]+\/board-claim\/([0-9a-f]+)\?code=([0-9a-f]+)/g)];
  must(links.length > 0, "owner link printed by the server");
  const [, token, code] = links[links.length - 1];
  const anon = new Session();
  const challenge = await anon.request("GET", `/api/board-claim/${token}?code=${code}`);
  must(challenge.json?.status === "available", `first-run owner link is open (${challenge.json?.status})`);
  const page = await anon.request("GET", `/board-claim/${token}?code=${code}`, undefined, { Accept: "text/html" });
  check(page.status === 200 && /<html/i.test(page.text), "first-run screen served");
  const before = await anon.request("GET", "/api/companies");
  check(before.status === 401 || before.status === 403, `nothing readable before sign-in (${before.status})`);

  // What the owner does on the first-run screen: make a log-in, then claim.
  const owner = new Session();
  const email = "owner@aura.invalid";
  const password = randomBytes(18).toString("base64url");
  must((await owner.request("POST", "/api/auth/sign-up/email", { name: "Aura owner", email, password })).status === 200, "owner log-in created");
  const claimed = await owner.request("POST", `/api/board-claim/${token}/claim`, { code });
  must(claimed.status === 200 && claimed.json?.claimed === true, `owner claimed the install (${claimed.status})`);

  const companies = list((await owner.request("GET", "/api/companies")).json, "companies");
  must(companies.length === 1 && companies[0].name === "Aura", `exactly one company, "Aura" (${companies.map((c) => c.name).join(", ") || "none"})`);
  const companyId = companies[0].id;
  const agents = list((await owner.request("GET", `/api/companies/${companyId}/agents`)).json, "agents").map((a) => a.name);
  const expectTemplate = process.env.EXPECT_TEMPLATE === "1";
  check(
    expectTemplate ? agents.length === 1 && agents[0] === "John" : agents.length === 0,
    `agents: ${agents.join(", ") || "none"} (expected ${expectTemplate ? "John only" : "none"})`,
  );
  const secrets = await owner.request("GET", `/api/companies/${companyId}/secrets`);
  check(secrets.status === 200 && list(secrets.json, "secrets").length === 0, `no secrets (${list(secrets.json, "secrets").length})`);
  const general = (await owner.request("GET", "/api/instance/settings/general")).json;
  check(general?.runAdmission?.maxConcurrentRuns === 2, `agent cap 2 (${general?.runAdmission?.maxConcurrentRuns})`);
  check(!general?.aiAccessRoute, `no install-wide AI route (${general?.aiAccessRoute ?? "none"})`);
  const members = (await owner.request("GET", `/api/companies/${companyId}/members`)).json;
  const humans = list(members, "members").filter((m) => m.principalType === "user" && m.principalId !== "local-board" && m.status === "active");
  check(humans.length === 1 && humans[0].membershipRole === "owner", `one human member, the owner (${humans.map((m) => m.membershipRole).join(", ")})`);

  writeFileSync(stateFile, JSON.stringify({ email, password, companyId }));
} else if (phase === "invite") {
  const [stateFile] = rest;
  const { email, password, companyId } = JSON.parse(readFileSync(stateFile, "utf8"));
  const stranger = await new Session().request("POST", "/api/auth/sign-up/email", { name: "Stranger", email: "stranger@aura.invalid", password: randomBytes(18).toString("base64url") });
  check(stranger.status !== 200, `public sign-up closed after setup (${stranger.status})`);

  const owner = new Session();
  must((await owner.request("POST", "/api/auth/sign-in/email", { email, password })).status === 200, "owner signs in again after the restart");
  const invite = await owner.request("POST", `/api/companies/${companyId}/invites`, { allowedJoinTypes: "human", humanRole: "operator" });
  must([200, 201].includes(invite.status) && invite.json?.token, `owner invites a helper (${invite.status})`);

  const helper = new Session();
  const helperEmail = "helper@aura.invalid";
  const signUp = await helper.request("POST", "/api/auth/sign-up/email", { name: "Helper", email: helperEmail, password: randomBytes(18).toString("base64url") }, { "x-gsam-invite-token": invite.json.token });
  must(signUp.status === 200, `helper makes a log-in with the invite (${signUp.status})`);
  const accept = await helper.request("POST", `/api/invites/${invite.json.token}/accept`, { requestType: "human" });
  must([200, 201, 202].includes(accept.status), `helper accepts the invite (${accept.status})`);
  const pending = list((await owner.request("GET", `/api/companies/${companyId}/join-requests?status=pending_approval`)).json, "joinRequests");
  const request = pending.find((r) => r.requestEmailSnapshot === helperEmail) ?? pending[0];
  if (request) {
    const approved = await owner.request("POST", `/api/companies/${companyId}/join-requests/${request.id}/approve`, {});
    must(approved.status === 200, `owner approves the helper (${approved.status})`);
  }
  const helperCompanies = list((await helper.request("GET", "/api/companies")).json, "companies");
  check(helperCompanies.some((c) => c.id === companyId), "helper is a member of Aura");
} else {
  console.error("usage: smoke-test.mjs first-run|invite ...");
  process.exit(2);
}

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log(`${phase}: all checks passed`);
