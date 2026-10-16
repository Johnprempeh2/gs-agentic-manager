// @vitest-environment jsdom
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { clearSnapshots, restoreSnapshots, saveSnapshot, snapshotPageFor } from "./offline-snapshot";

afterEach(() => localStorage.clear());

/** A query with data and something showing it, as on an open page. */
function shown(client: QueryClient, key: unknown[], data: unknown, updatedAt: number) {
  client.setQueryData(key, data, { updatedAt });
  const observer = new QueryObserver(client, { queryKey: key, queryFn: async () => data, enabled: false });
  return observer.subscribe(() => {});
}

describe("offline snapshot", () => {
  it("saves only the four chosen pages", () => {
    expect(snapshotPageFor("/GRE/inbox/mine")).toBe("inbox");
    expect(snapshotPageFor("/GRE/needed")).toBe("needed");
    expect(snapshotPageFor("/GRE/organisations")).toBe("clients");
    expect(snapshotPageFor("/GRE/today")).toBe("today");
    expect(snapshotPageFor("/GRE/morning")).toBe("today");
    expect(snapshotPageFor("/GRE/organisations/abc")).toBeNull();
    expect(snapshotPageFor("/GRE/issues/GRE-1")).toBeNull();
    expect(snapshotPageFor("/GRE/settings")).toBeNull();
  });

  it("puts back what was on screen, with the time it was really loaded", () => {
    const before = new QueryClient();
    const stop = shown(before, ["issues", "GRE"], [{ id: "a", title: "Send the proposal" }], 1_000);
    before.setQueryData(["not", "shown"], "unseen");
    expect(saveSnapshot(before, "inbox", 2_000)).toBe(true);
    stop();

    const after = new QueryClient();
    expect(restoreSnapshots(after, 3_000)).toBe(1);
    expect(after.getQueryData(["issues", "GRE"])).toEqual([{ id: "a", title: "Send the proposal" }]);
    expect(after.getQueryState(["issues", "GRE"])?.dataUpdatedAt).toBe(1_000);
    expect(after.getQueryData(["not", "shown"])).toBeUndefined();
  });

  it("drops a copy older than a week, and everything on sign out", () => {
    const client = new QueryClient();
    const stop = shown(client, ["clients"], ["Acme"], 1_000);
    saveSnapshot(client, "clients", 1_000);
    saveSnapshot(client, "today", 1_000);
    stop();

    expect(restoreSnapshots(new QueryClient(), 1_000 + 8 * 24 * 60 * 60 * 1000)).toBe(0);
    expect(localStorage.length).toBe(0);

    const again = new QueryClient();
    const stopAgain = shown(again, ["clients"], ["Acme"], 1_000);
    saveSnapshot(again, "clients", 1_000);
    stopAgain();
    clearSnapshots();
    expect(restoreSnapshots(new QueryClient(), 2_000)).toBe(0);
  });

  it("throws away a copy it cannot read", () => {
    localStorage.setItem("gsam.offline-snapshot.v1:inbox", "{not json");
    expect(restoreSnapshots(new QueryClient())).toBe(0);
    expect(localStorage.getItem("gsam.offline-snapshot.v1:inbox")).toBeNull();
  });
});
