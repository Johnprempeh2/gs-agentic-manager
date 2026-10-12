import { describe, expect, it } from "vitest";
import { resolveDescribeEmbeddedPostgres } from "./helpers/route-test-harness.js";

// GRE-907: a Postgres-backed suite that is skipped must say why, and can be
// made to fail instead so a sandbox run cannot report a silent pass.
describe("resolveDescribeEmbeddedPostgres", () => {
  const unavailable = { supported: false, reason: "could not bind IPv4 address" };

  it("returns describe and prints nothing when Postgres starts", () => {
    const lines: string[] = [];
    const result = resolveDescribeEmbeddedPostgres({ supported: true }, { env: {}, log: (l) => lines.push(l) });
    expect(result).toBe(describe);
    expect(lines).toEqual([]);
  });

  it("skips and prints the reason when Postgres is unavailable", () => {
    const lines: string[] = [];
    const result = resolveDescribeEmbeddedPostgres(unavailable, { env: {}, log: (l) => lines.push(l) });
    // `describe.skip` is a fresh chain on each access, so check it is not `describe`.
    expect(result).not.toBe(describe);
    expect(lines).toEqual(["embedded Postgres unavailable, suites skipped: could not bind IPv4 address"]);
  });

  it("fails with the reason when GSAM_REQUIRE_EMBEDDED_PG=1", () => {
    const lines: string[] = [];
    expect(() =>
      resolveDescribeEmbeddedPostgres(unavailable, {
        env: { GSAM_REQUIRE_EMBEDDED_PG: "1" },
        log: (l) => lines.push(l),
      }),
    ).toThrow("embedded Postgres unavailable and GSAM_REQUIRE_EMBEDDED_PG=1: could not bind IPv4 address");
    expect(lines).toEqual([]);
  });

  it("keeps skipping for any other flag value", () => {
    const result = resolveDescribeEmbeddedPostgres(unavailable, {
      env: { GSAM_REQUIRE_EMBEDDED_PG: "0" },
      log: () => {},
    });
    expect(result).not.toBe(describe);
  });
});
