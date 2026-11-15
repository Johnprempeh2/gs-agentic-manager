import { describe, expect, it } from "vitest";
import { memberActivityQuery } from "./MemberActivityDialog";

describe("member activity filters", () => {
  it("sends no query without filters", () => {
    expect(memberActivityQuery({ types: [] })).toBe("");
  });
  it("covers whole days and joins the chosen types", () => {
    const query = new URLSearchParams(memberActivityQuery({ from: "2026-11-16", to: "2026-11-16", types: ["sign_in", "decision"] }).slice(1));
    expect(new Date(query.get("to")!).getTime() - new Date(query.get("from")!).getTime()).toBe(86_400_000 - 1);
    expect(query.get("types")).toBe("sign_in,decision");
  });
});
