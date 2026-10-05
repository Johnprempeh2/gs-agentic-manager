/**
 * Where the UI's own dev servers listen: Vite dev and preview, Storybook, and
 * the static Storybook server the visual tests use.
 *
 * The default is loopback (127.0.0.1). On 5 Oct 2026 two Storybook servers that
 * agent runs had started listened on every interface, so every device on the
 * private network (Tailscale) could open them. Agents only need these servers on
 * the machine itself, for screenshots.
 *
 * GSAM_DEV_HOST opts in to another address, for example
 * `GSAM_DEV_HOST=0.0.0.0 pnpm dev:mobile` to open the preview from a phone.
 * The main server is not affected: it has its own bind setting.
 *
 * Plain JavaScript (types in dev-server-host.d.mts) so that Storybook's main.ts,
 * the Vite configs and Node scripts can all import it with an explicit extension.
 */
export const DEV_SERVER_HOST_ENV = "GSAM_DEV_HOST";
export const DEFAULT_DEV_SERVER_HOST = "127.0.0.1";

/** @param {string | undefined} value */
export function resolveDevServerHost(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_DEV_SERVER_HOST;
}

/** @param {string} host */
export function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  );
}

/** @param {unknown} value */
function isPortArg(value) {
  return typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value));
}

/**
 * Makes `server.listen(...)` use `host` when the caller gave no host, and
 * leaves an explicit host alone.
 *
 * Storybook 10 listens with `listen({ port, host: options.host })`, and
 * `options.host` is unset unless `--host` or `SBCONFIG_HOSTNAME` is given, so
 * by default it listens on every interface. Storybook has no main.ts setting
 * for the host; its `experimental_devServer` hook hands over the dev server
 * before it listens, which is where this is applied.
 *
 * Handles `listen(options, cb?)` and `listen(port, host?, backlog?, cb?)`.
 * Anything else (a socket path, a handle) passes through unchanged.
 *
 * @template {object} T
 * @param {T} server
 * @param {string} host
 * @param {(host: string) => void} [onDefaultHost]
 * @returns {T}
 */
export function defaultListenHost(server, host, onDefaultHost) {
  const target = /** @type {{ listen?: (...args: unknown[]) => unknown }} */ (server);
  if (typeof target.listen !== "function") return server;
  const listen = target.listen.bind(server);
  target.listen = (...args) => {
    const [first, ...rest] = args;
    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      const options = /** @type {{ host?: unknown; path?: unknown }} */ (first);
      if (options.host || options.path || !("port" in options)) return listen(...args);
      onDefaultHost?.(host);
      return listen({ ...options, host }, ...rest);
    }
    if (isPortArg(first)) {
      const [second, ...others] = rest;
      if (typeof second === "string" && second) return listen(...args);
      onDefaultHost?.(host);
      if (rest.length > 0 && (second === undefined || second === null)) {
        return listen(first, host, ...others);
      }
      return listen(first, host, ...rest);
    }
    return listen(...args);
  };
  return server;
}
