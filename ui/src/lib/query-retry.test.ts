import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { shouldRetryQuery } from "./query-retry";

describe("shouldRetryQuery", () => {
  it("never retries a final answer", () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(shouldRetryQuery(0, new ApiError("no", status, null)), String(status)).toBe(false);
    }
  });

  it("retries a server error or a dropped connection up to three times", () => {
    expect(shouldRetryQuery(0, new ApiError("busy", 503, null))).toBe(true);
    expect(shouldRetryQuery(2, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryQuery(3, new ApiError("busy", 503, null))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("slow down", 429, null))).toBe(true);
  });
});
