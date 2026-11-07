// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { liveDesignApi } from "../api/liveDesign";
import { useLiveDesign } from "./LiveDesignChat";

describe("useLiveDesign", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("starts a new session when GSAM has forgotten the open one (a release restart)", async () => {
    vi.useFakeTimers();
    let n = 0;
    const start = vi.fn(async () => ({ id: `s${++n}`, status: "idle", messages: [] }) as never);
    vi.spyOn(liveDesignApi, "get").mockRejectedValue(new ApiError("Live session not found", 404, null));
    vi.spyOn(liveDesignApi, "end").mockResolvedValue(undefined as never);
    const result = { current: null as unknown as ReturnType<typeof useLiveDesign> };
    function Probe() { result.current = useLiveDesign(start, "page", true); return null; }
    act(() => createRoot(document.createElement("div")).render(<Probe />));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.sessionId).toBe("s1");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(start).toHaveBeenCalledTimes(2);
    expect(result.current.sessionId).toBe("s2");
  });
});
