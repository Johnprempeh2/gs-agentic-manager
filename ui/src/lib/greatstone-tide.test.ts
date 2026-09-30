// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountGreatstoneTide } from "./greatstone-tide";

type ViewCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

let viewCallback: ViewCallback | null;
let observerDisconnected: boolean;
let frames: FrameRequestCallback[];
let reducedMotion: boolean;
let clears: number;

function inView(isIntersecting: boolean) {
  viewCallback?.([{ isIntersecting }]);
}

/** Runs the frames queued so far (not ones they queue in turn). */
function runFrames() {
  const queued = frames;
  frames = [];
  for (const frame of queued) frame(performance.now());
}

beforeEach(() => {
  viewCallback = null;
  observerDisconnected = false;
  frames = [];
  reducedMotion = false;
  clears = 0;

  // jsdom has no 2D canvas; a recording stub is enough to drive the loop.
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "clearRect") return () => { clears += 1; };
        if (key === "createRadialGradient") return () => ({ addColorStop() {} });
        return () => {};
      },
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as RenderingContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({ matches: reducedMotion && query.includes("reduced-motion") }) as MediaQueryList,
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: ViewCallback) {
        viewCallback = cb;
      }
      observe() {}
      disconnect() {
        observerDisconnected = true;
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mountGreatstoneTide", () => {
  it("parks the loop while the host is off screen and resumes when it returns", () => {
    const host = document.createElement("div");
    const tide = mountGreatstoneTide(host);
    expect(clears).toBe(1); // the synchronous first frame
    expect(frames).toHaveLength(1);

    runFrames();
    expect(clears).toBe(2);
    expect(frames).toHaveLength(1);

    inView(false);
    runFrames();
    expect(clears).toBe(2); // no paint off screen
    expect(frames).toHaveLength(0); // and no frame queued: the loop is parked

    inView(true);
    expect(frames).toHaveLength(1);
    runFrames();
    expect(clears).toBe(3);

    tide.destroy();
    expect(frames).toHaveLength(0);
    expect(observerDisconnected).toBe(true);
    expect(host.querySelector("canvas")).toBeNull();
  });

  it("draws one still frame and never loops under reduced motion", () => {
    reducedMotion = true;
    const host = document.createElement("div");
    const tide = mountGreatstoneTide(host);
    expect(clears).toBe(1);
    expect(frames).toHaveLength(0);

    inView(false);
    inView(true);
    expect(frames).toHaveLength(0);
    tide.destroy();
  });
});
