import { describe, expect, it } from "vitest";
import { createEngineCallSlots, withEngineTimeout, MemoryEngineUnavailableError } from "./engine.js";

describe("createEngineCallSlots", () => {
  it("refuses work over the bound and frees a slot when the call settles, even after a timeout", async () => {
    const slots = createEngineCallSlots(1);
    let finish!: () => void;
    const first = slots.tryRun(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(first).not.toBeNull();

    // The gateway stops waiting, but the engine is still busy: the slot stays held.
    await expect(withEngineTimeout(first!, 10)).rejects.toBeInstanceOf(MemoryEngineUnavailableError);
    expect(slots.tryRun(async () => "late")).toBeNull();

    finish();
    await first;
    const failing = slots.tryRun(async () => {
      throw new Error("engine said no");
    });
    await expect(failing).rejects.toThrow("engine said no");
    await expect(slots.tryRun(async () => "free again")).resolves.toBe("free again");
  });
});
