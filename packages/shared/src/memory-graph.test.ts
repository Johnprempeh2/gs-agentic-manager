import { describe, expect, it } from "vitest";
import {
  MEMORY_GRAPH_EDGE_TYPES,
  memoryActivityCountsQuerySchema,
  memoryActivityQuerySchema,
  memoryGraphQuerySchema,
} from "./memory.js";

// Query contract for the memory graph and activity read API (GRE-864).
describe("memory graph query schemas", () => {
  it("parses a comma list or repeated status values and applies the default limit", () => {
    expect(memoryGraphQuerySchema.parse({ status: "approved, disputed" })).toEqual({ status: ["approved", "disputed"], limit: 200 });
    expect(memoryGraphQuerySchema.parse({ status: ["unreviewed"], limit: "5" })).toEqual({ status: ["unreviewed"], limit: 5 });
  });

  it("never lists deleted tombstones in the graph, but the feed may ask for them", () => {
    expect(memoryGraphQuerySchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(memoryActivityQuerySchema.parse({ status: "deleted" }).status).toEqual(["deleted"]);
  });

  it("rejects unknown filters and out-of-range limits", () => {
    expect(memoryGraphQuerySchema.safeParse({ companyId: "x" }).success).toBe(false);
    expect(memoryGraphQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(memoryActivityQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(memoryGraphQuerySchema.safeParse({ agentId: "not-a-uuid" }).success).toBe(false);
  });

  it("counts take the feed filters except who contributed and paging", () => {
    expect(memoryActivityCountsQuerySchema.parse({ from: "2026-10-01", status: "approved" })).toEqual({
      from: new Date("2026-10-01"),
      status: ["approved"],
    });
    expect(memoryActivityCountsQuerySchema.safeParse({ agentId: "00000000-0000-4000-8000-000000000000" }).success).toBe(false);
    expect(memoryActivityCountsQuerySchema.safeParse({ cursor: "abc" }).success).toBe(false);
  });

  it("edge types are the stated relationship types plus supersession and the conflict check", () => {
    expect(MEMORY_GRAPH_EDGE_TYPES).toEqual(["supports", "contradicts", "refines", "depends_on", "same_subject", "supersedes", "possible_conflict"]);
  });
});
