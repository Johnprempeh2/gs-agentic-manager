// The release queue service against the real scripts/greatstone-release-queue.mjs
// in a temp GSAM root: the server enqueues and cancels through the script and
// reads queue.json back for the Releases page.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { logTail, readReleaseQueue, releaseQueueService } from "../services/release-queue.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-release-queue-svc-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("release queue service", () => {
  it("enqueues and cancels through the script, and a title that looks like an option stays a title", async () => {
    const root = tempRoot();
    const svc = releaseQueueService({ ...process.env, GSAM_ROOT: root, GSAM_RELEASE_QUEUE_DIR: "" });
    expect(svc.view()).toEqual({ running: null, queued: [], recent: [], main: null, workerSeenAt: null });

    const queued = await svc.enqueue(repo, { ref: "main", title: "--json", by: "user:john" });
    expect(queued).toMatchObject({ ok: true, item: { ref: "main", title: "--json", requestedBy: "user:john", status: "queued" } });
    if (!queued.ok) throw new Error("expected ok");
    expect(svc.view().queued.map((i) => i.id)).toEqual([queued.item.id]);
    expect(JSON.stringify(svc.view())).not.toContain(root); // log paths stay on the host

    const bad = await svc.enqueue(repo, { ref: "main", title: "Release candidate rc-2026-10-18.1", by: "user:john" });
    expect(bad).toMatchObject({ ok: false, status: 422 });

    expect(await svc.cancel(repo, { id: queued.item.id, by: "user:john" })).toMatchObject({ ok: true, item: { status: "cancelled" } });
    expect(await svc.cancel(repo, { id: "rq-000000", by: "user:john" })).toMatchObject({ ok: false, status: 404 });
    expect(svc.view().recent[0]).toMatchObject({ id: queued.item.id, status: "cancelled", reason: "cancelled by user:john" });
  });

  it("shows the running request's log tail, and reads no file outside the queue folder", () => {
    const dir = path.join(tempRoot(), "release-queue");
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    const log = path.join(dir, "logs", "rq-aaaaaa.log");
    fs.writeFileSync(log, `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n\u001b[31mFAIL\u001b[0m last\n`);
    const outside = path.join(path.dirname(dir), "secret.txt");
    fs.writeFileSync(outside, "do not show\n");
    fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify({
      items: [
        { id: "rq-aaaaaa", ref: "main", status: "running", step: "gate", log },
        { id: "rq-bbbbbb", ref: "main", status: "released", log },
      ],
      main: { commit: "abc", status: "testing" },
      worker: { pid: 1, seenAt: "2026-10-18T12:00:00Z" },
    }));
    const view = readReleaseQueue(dir);
    expect(view.running?.logTail).toHaveLength(20);
    expect(view.running?.logTail.at(-1)).toBe("FAIL last");
    expect(view.recent.map((i) => i.id)).toEqual(["rq-bbbbbb"]);
    expect(view.workerSeenAt).toBe("2026-10-18T12:00:00Z");
    expect(logTail(dir, outside)).toEqual([]);
    expect(logTail(dir, path.join(dir, "logs", "..", "..", "secret.txt"))).toEqual([]);
  });
});
