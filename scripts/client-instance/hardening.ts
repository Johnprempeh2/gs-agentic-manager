/**
 * Security checks `verify` runs on a client instance, for the lines of the
 * per-client checklist (doc/CLIENT-PUBLIC-SECURITY.md) that a script can
 * answer. Each function is pure: it is handed what verify read (headers, the
 * config, the .env text, file modes) and returns PASS or FAIL lines.
 */

export interface HardeningCheck {
  ok: boolean;
  line: string;
}

/** The browser protections the server sets on every response (security-headers.ts). */
export function securityHeaderChecks(headers: Headers, where: string): HardeningCheck[] {
  const get = (name: string) => headers.get(name)?.toLowerCase() ?? "";
  return [
    { ok: get("x-content-type-options") === "nosniff", line: `${where}: X-Content-Type-Options is nosniff` },
    { ok: get("x-frame-options") === "sameorigin", line: `${where}: X-Frame-Options is SAMEORIGIN` },
    {
      ok: /frame-ancestors 'self'/.test(get("content-security-policy")),
      line: `${where}: Content-Security-Policy has frame-ancestors 'self'`,
    },
    { ok: !headers.has("x-powered-by"), line: `${where}: no X-Powered-By header` },
  ];
}

export function hstsCheck(headers: Headers, where: string): HardeningCheck {
  const value = headers.get("strict-transport-security") ?? "";
  const maxAge = Number(/max-age=(\d+)/i.exec(value)?.[1] ?? 0);
  return { ok: maxAge >= 86_400 * 30, line: `${where}: Strict-Transport-Security is set (max-age ${maxAge || "missing"})` };
}

export interface PublicAddress {
  /** https://<host>, or null while the instance has no public address yet. */
  baseUrl: string | null;
  host: string | null;
}

/** The public address public-url.sh wrote into config.json, if any. */
export function publicAddress(config: unknown): PublicAddress {
  const auth = (config as { auth?: { baseUrlMode?: unknown; publicBaseUrl?: unknown } } | null)?.auth;
  if (auth?.baseUrlMode !== "explicit" || typeof auth.publicBaseUrl !== "string") return { baseUrl: null, host: null };
  try {
    const url = new URL(auth.publicBaseUrl);
    return { baseUrl: url.origin, host: url.hostname };
  } catch {
    return { baseUrl: null, host: null };
  }
}

/** Mode, sign-up and hostnames from config.json. */
export function configChecks(config: unknown): HardeningCheck[] {
  const c = (config ?? {}) as {
    server?: { deploymentMode?: unknown; bind?: unknown; host?: unknown; allowedHostnames?: unknown };
    auth?: { publicBaseUrl?: unknown };
  };
  const checks: HardeningCheck[] = [
    { ok: c.server?.deploymentMode === "authenticated", line: `mode is authenticated (config: ${String(c.server?.deploymentMode ?? "unset")})` },
    {
      ok: c.server?.host === "127.0.0.1" || c.server?.bind === "loopback",
      line: `the server listens on loopback only (host ${String(c.server?.host ?? "unset")})`,
    },
  ];
  const address = publicAddress(config);
  if (address.baseUrl) {
    checks.push({ ok: address.baseUrl.startsWith("https://"), line: `public address is HTTPS (${address.baseUrl})` });
    const allowed = Array.isArray(c.server?.allowedHostnames) ? (c.server.allowedHostnames as unknown[]) : [];
    const unexpected = allowed.filter((name) => name !== address.host && name !== "127.0.0.1" && name !== "localhost");
    checks.push({
      ok: unexpected.length === 0,
      line: `allowed hostnames are only the public address and loopback${unexpected.length ? ` (also: ${unexpected.join(", ")})` : ""}`,
    });
  }
  return checks;
}

/** Variables in the instance .env that weaken sign-in. */
export function envChecks(envText: string, hasPublicAddress: boolean): HardeningCheck[] {
  const values = new Map<string, string>();
  for (const raw of envText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
  }
  const secret = values.get("BETTER_AUTH_SECRET") ?? "";
  const checks: HardeningCheck[] = [
    { ok: secret.length >= 32, line: "the instance has its own auth secret (BETTER_AUTH_SECRET, 32+ characters)" },
    {
      ok: values.get("GSAM_AUTH_RATE_LIMIT_ENABLED")?.toLowerCase() !== "false",
      line: "the sign-in rate limit is not turned off (GSAM_AUTH_RATE_LIMIT_ENABLED)",
    },
  ];
  if (hasPublicAddress) {
    checks.push({ ok: values.get("TRUST_PROXY") === "loopback", line: `TRUST_PROXY is loopback (${values.get("TRUST_PROXY") ?? "unset"})` });
  }
  return checks;
}

/**
 * A secret file readable by its owner only. `mode` is fs.Stats.mode, or null
 * when the file is missing, which passes only for a file made on first use.
 */
export function privateFileCheck(label: string, mode: number | null, opts: { madeOnFirstUse?: boolean } = {}): HardeningCheck {
  if (mode === null) {
    return opts.madeOnFirstUse
      ? { ok: true, line: `${label} is not made yet (made on first use, mode 600)` }
      : { ok: false, line: `${label} exists and is private (missing)` };
  }
  const perms = mode & 0o777;
  return { ok: (perms & 0o077) === 0, line: `${label} is readable by its owner only (mode ${perms.toString(8).padStart(3, "0")})` };
}

/** Plain HTTP to the public host must send the browser to HTTPS. */
export function httpRedirectCheck(status: number | null, location: string | null, host: string): HardeningCheck {
  let target: URL | null = null;
  try {
    target = location ? new URL(location) : null;
  } catch {
    target = null;
  }
  const ok = status !== null && status >= 300 && status < 400 && target?.protocol === "https:" && target.hostname === host;
  return { ok, line: `http://${host}/ redirects to HTTPS (-> ${status ?? "no answer"}${location ? ` ${location}` : ""})` };
}
