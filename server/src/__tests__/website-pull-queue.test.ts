import { describe, expect, it } from "vitest";
import { serialPulls } from "../services/website/pull-queue.js";

function gatedPull() {
  const calls: (string[] | undefined)[] = [];
  let release: () => void = () => {};
  const pull = async (siteIds?: string[]) => {
    calls.push(siteIds);
    if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  };
  return { calls, pull, release: () => release() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("serialPulls", () => {
  it("pulls every site that pinged during a running pull", async () => {
    const gate = gatedPull();
    const run = serialPulls(gate.pull);
    const first = run(["a"]);
    await run(["b"]);
    await run(["c"]);
    await run(["b"]);
    gate.release();
    await first;
    await settle();
    expect(gate.calls).toEqual([["a"], ["b", "c"]]);
  });

  it("a full pull queued during a running pull is not narrowed by a later ping", async () => {
    const gate = gatedPull();
    const run = serialPulls(gate.pull);
    const first = run(["a"]);
    await run();
    await run(["b"]);
    gate.release();
    await first;
    await settle();
    expect(gate.calls).toEqual([["a"], undefined]);
  });

  it("runs nothing more when no ping lands during the pull", async () => {
    const gate = gatedPull();
    const run = serialPulls(gate.pull);
    const first = run(["a"]);
    gate.release();
    await first;
    await settle();
    expect(gate.calls).toEqual([["a"]]);
  });
});
