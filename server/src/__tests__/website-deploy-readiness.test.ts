import { describe, expect, it } from "vitest";
import { deployBlockers, deployRefusal } from "../services/website/deploy-readiness.js";

function fakeFetch(opts: { offerings?: unknown[]; release?: number | null; status?: Record<string, number> }) {
  return (async (input: string | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/current")) return opts.release === null ? new Response("", { status: 404 }) : json({ release: opts.release ?? 7 });
    if (url.includes("/releases/")) return json({ collections: { offerings: opts.offerings ?? [] } });
    const path = new URL(url).pathname;
    return new Response("ok", { status: opts.status?.[path] ?? 200 });
  }) as typeof fetch;
}

const product = { key: "aspose-words", fields: { slug: "aspose-words" } };

describe("deployBlockers", () => {
  it("passes when staging has products and every key page answers 200", async () => {
    expect(await deployBlockers("t", "gsam-content", fakeFetch({ offerings: [product] }))).toEqual([]);
  });

  it("reads the wrapped { entries } collection shape too", async () => {
    const wrapped = (async (input: string | URL) => String(input).includes("/releases/")
      ? new Response(JSON.stringify({ collections: { offerings: { fieldsVersion: 1, entries: [product] } } }))
      : fakeFetch({ offerings: [product] })(input)) as typeof fetch;
    expect(await deployBlockers("t", "gsam-content", wrapped)).toEqual([]);
  });

  it("refuses a release with 0 products", async () => {
    const problems = await deployBlockers("t", "gsam-content", fakeFetch({ offerings: [] }));
    expect(problems).toEqual(["Staging's content release 7 has 0 products, so the shop would be empty on greatstoneint.com."]);
  });

  it("refuses when staging has no content release", async () => {
    expect(await deployBlockers("t", "gsam-content", fakeFetch({ release: null }))).toContain(
      "Staging has no content release, so there is nothing safe to deploy.",
    );
  });

  it("names each key page and the sample product that is not 200", async () => {
    const problems = await deployBlockers("t", "gsam-content", fakeFetch({ offerings: [product], status: { "/shop": 500, "/product/aspose-words": 404 } }));
    expect(problems.sort()).toEqual(["Staging page /product/aspose-words answers 404, not 200.", "Staging page /shop answers 500, not 200."]);
    expect(deployRefusal(problems)).toMatch(/^Deploy stopped: staging is not ready, so greatstoneint.com was not changed\. /);
  });

  it("fails closed when a page does not answer", async () => {
    const broken = (async (input: string | URL) => {
      if (String(input).endsWith("/contact")) throw new Error("timeout");
      return fakeFetch({ offerings: [product] })(input);
    }) as typeof fetch;
    expect(await deployBlockers("t", "gsam-content", broken)).toEqual(["Staging page /contact did not answer."]);
  });
});
