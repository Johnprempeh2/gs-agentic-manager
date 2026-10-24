import { afterEach, describe, expect, it, vi } from "vitest";
import { framingOf } from "../services/website/home.js";

const ok = () => new Response(null, { status: 200, headers: { "content-security-policy": "frame-ancestors 'self' https://gsam.example" } });

describe("framingOf", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tries again when the first check is slow, instead of hiding the site", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    expect(await framingOf("https://retry.example/", ["https://gsam.example"])).toBe("allowed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("remembers a miss only briefly", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
      vi.stubGlobal("fetch", fetchMock);
      expect(await framingOf("https://miss.example/", ["https://gsam.example"])).toBe("unknown");
      fetchMock.mockReset().mockResolvedValue(ok());
      vi.advanceTimersByTime(31_000);
      expect(await framingOf("https://miss.example/", ["https://gsam.example"])).toBe("allowed");
    } finally {
      vi.useRealTimers();
    }
  });
});
