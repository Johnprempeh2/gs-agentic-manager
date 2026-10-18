// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/hardening.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configChecks,
  envChecks,
  hstsCheck,
  httpRedirectCheck,
  privateFileCheck,
  publicAddress,
  securityHeaderChecks,
} from "./hardening.js";

const failed = (checks: { ok: boolean; line: string }[]) => checks.filter((c) => !c.ok).map((c) => c.line);

test("the server's own headers pass, and a missing one fails by name", () => {
  const good = new Headers({
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  });
  assert.deepEqual(failed(securityHeaderChecks(good, "loopback")), []);
  const bad = new Headers({ "x-powered-by": "Express", "x-content-type-options": "nosniff" });
  const lines = failed(securityHeaderChecks(bad, "public"));
  assert.equal(lines.length, 3);
  assert.match(lines.join("\n"), /X-Frame-Options/);
  assert.match(lines.join("\n"), /X-Powered-By/);
});

test("HSTS needs at least 30 days", () => {
  assert.equal(hstsCheck(new Headers({ "strict-transport-security": "max-age=15552000" }), "public").ok, true);
  assert.equal(hstsCheck(new Headers({ "strict-transport-security": "max-age=60" }), "public").ok, false);
  assert.match(hstsCheck(new Headers(), "public").line, /missing/);
});

const created = {
  server: { deploymentMode: "authenticated", exposure: "private", bind: "loopback", host: "127.0.0.1", allowedHostnames: [] },
  auth: { baseUrlMode: "auto", disableSignUp: false },
};
const published = {
  server: { ...created.server, allowedHostnames: ["acme.greatstone.example", "127.0.0.1"] },
  auth: { baseUrlMode: "explicit", publicBaseUrl: "https://acme.greatstone.example" },
};

test("a new instance has no public address; public-url.sh adds one", () => {
  assert.deepEqual(publicAddress(created), { baseUrl: null, host: null });
  assert.deepEqual(publicAddress(published), { baseUrl: "https://acme.greatstone.example", host: "acme.greatstone.example" });
  assert.deepEqual(failed(configChecks(created)), []);
  assert.deepEqual(failed(configChecks(published)), []);
});

test("local trusted mode, a public bind, plain HTTP or an extra hostname fail", () => {
  const lines = failed(
    configChecks({
      server: { deploymentMode: "local_trusted", bind: "lan", host: "0.0.0.0", allowedHostnames: ["acme.example", "other.example"] },
      auth: { baseUrlMode: "explicit", publicBaseUrl: "http://acme.example" },
    }),
  );
  assert.equal(lines.length, 4);
  assert.match(lines.join("\n"), /also: other\.example/);
});

test(".env: own secret, rate limit on, and TRUST_PROXY once public", () => {
  const secret = `BETTER_AUTH_SECRET=${"a".repeat(64)}\n`;
  assert.deepEqual(failed(envChecks(secret, false)), []);
  assert.deepEqual(failed(envChecks(`${secret}TRUST_PROXY=loopback\n`, true)), []);
  assert.match(failed(envChecks(secret, true)).join(), /TRUST_PROXY is loopback \(unset\)/);
  assert.match(failed(envChecks(`${secret}GSAM_AUTH_RATE_LIMIT_ENABLED="False"\n`, false)).join(), /rate limit/);
  assert.match(failed(envChecks("BETTER_AUTH_SECRET=short\n", false)).join(), /auth secret/);
});

test("secret files must be owner-only; the secrets key may not exist yet", () => {
  assert.equal(privateFileCheck(".env", 0o100600).ok, true);
  assert.equal(privateFileCheck(".env", 0o100644).ok, false);
  assert.match(privateFileCheck(".env", 0o100644).line, /mode 644/);
  assert.equal(privateFileCheck(".env", null).ok, false);
  assert.equal(privateFileCheck("secrets master key", null, { madeOnFirstUse: true }).ok, true);
});

test("plain HTTP must redirect to the same host over HTTPS", () => {
  assert.equal(httpRedirectCheck(308, "https://acme.example/", "acme.example").ok, true);
  assert.equal(httpRedirectCheck(200, null, "acme.example").ok, false);
  assert.equal(httpRedirectCheck(301, "https://evil.example/", "acme.example").ok, false);
  assert.equal(httpRedirectCheck(301, "https://acme.example.evil.example/", "acme.example").ok, false);
  assert.match(httpRedirectCheck(null, null, "acme.example").line, /no answer/);
});
