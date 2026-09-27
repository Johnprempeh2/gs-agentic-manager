/**
 * The Greatstone "tide of time" (greatstone-tide skill), ported for the app.
 *
 * Concentric emerald arcs emanate outward from an off-frame focal point (time,
 * one direction, unbuyable), a lime "now" crest travels through them, and the
 * current bends toward the cursor. Pure Canvas 2D, no dependencies.
 *
 * Guarantees kept from the source: one synchronous frame on mount, the loop
 * pauses while the tab is hidden, reduced motion parks the field (no loop, no
 * warp), the pointer is measured relative to the host, and destroy() tears
 * everything down. Environments without a 2D canvas (tests) get a no-op.
 * In the app the loop also stops entirely while the host is scrolled out of
 * view, and the field follows its container's size, not just the window's.
 */

type Rgb = readonly [number, number, number];

export interface TideOptions {
  focalPoint?: { x: number; y: number };
  arcs?: number;
  segments?: number;
  sweep?: readonly [number, number];
  flowSpeed?: number;
  spread?: number;
  crest?: boolean;
  crestSpeed?: number;
  crestWidth?: number;
  warpRadius?: number;
  warpStrength?: number;
  well?: boolean;
  prominence?: number;
  dpr?: number;
}

// Obsidian-Lime. These are canvas paint values, not UI tokens.
const PALETTE = {
  deep: [34, 84, 62] as Rgb,
  emer: [58, 140, 100] as Rgb,
  lime: [200, 255, 0] as Rgb,
};

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const prefers = (query: string) =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches;

export function mountGreatstoneTide(container: HTMLElement, options: TideOptions = {}): { destroy(): void } {
  const o = {
    focalPoint: { x: 0.03, y: 1.07 },
    arcs: 48,
    segments: 120,
    sweep: [-1.92, 0.5] as const,
    flowSpeed: 0.16,
    spread: 1.2,
    crest: true,
    crestSpeed: 0.12,
    crestWidth: 0.05,
    warpRadius: 0.27,
    warpStrength: 42,
    well: true,
    prominence: 1,
    dpr: 2,
    ...options,
  };

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d", { alpha: true }) ?? null;
  if (!ctx) return { destroy() {} };

  const reduce = prefers("(prefers-reduced-motion: reduce)");
  const coarse = prefers("(hover:none),(pointer:coarse)");

  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;";
  container.appendChild(canvas);

  const N = o.arcs;
  const SEG = o.segments;
  const [A0, A1] = o.sweep;
  let W = 1;
  let H = 1;
  let F = { x: 0, y: 0 };
  let Rmax = 1;
  let SP = 1;
  const mouse = { x: 0, y: 0, active: false };
  const sm = { x: 0, y: 0 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, o.dpr);
    const rect = container.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    F = { x: W * o.focalPoint.x, y: H * o.focalPoint.y };
    Rmax = Math.hypot(W, H) * o.spread;
    SP = Rmax / N;
    if (sm.x > W || sm.y > H) {
      sm.x = W * 0.6;
      sm.y = H * 0.5;
    }
  }

  function onMove(event: PointerEvent) {
    const rect = container.getBoundingClientRect();
    mouse.x = event.clientX - rect.left;
    mouse.y = event.clientY - rect.top;
    mouse.active = true;
  }
  function onLeave() {
    mouse.active = false;
  }

  let t0: number | null = null;
  function draw(now: number) {
    if (t0 === null) t0 = now;
    const t = (now - t0) / 1000;
    sm.x += (mouse.x - sm.x) * 0.1;
    sm.y += (mouse.y - sm.y) * 0.1;
    const prom = reduce ? 0.9 : Math.min(1, Math.max(0, o.prominence));
    const c = ctx!;

    c.clearRect(0, 0, W, H);
    c.lineCap = "round";
    c.lineJoin = "round";

    const flow = reduce ? SP * 4 : t * SP * o.flowSpeed;
    const crestA = (t * o.crestSpeed) % 1;
    const crestB = (t * o.crestSpeed + 0.5) % 1;
    const warpR = Math.min(W, H) * o.warpRadius;
    const warpRq = warpR * warpR;

    for (let i = 0; i < N; i += 1) {
      const r = (i * SP + flow) % Rmax;
      const fr = r / Rmax;
      const edge = Math.min(1, fr / 0.05) * Math.min(1, (1 - fr) / 0.2);
      if (edge <= 0.012) continue;

      let bright = 0;
      if (o.crest) {
        const dc = Math.min(Math.abs(fr - crestA), Math.abs(fr - crestB));
        bright = Math.max(0, 1 - dc / o.crestWidth) * 0.88;
      }

      c.beginPath();
      for (let s = 0; s <= SEG; s += 1) {
        const a = A0 + (A1 - A0) * (s / SEG);
        let px = F.x + Math.cos(a) * r;
        let py = F.y + Math.sin(a) * r;
        if (mouse.active && !reduce) {
          const dx = px - sm.x;
          const dy = py - sm.y;
          const dq = dx * dx + dy * dy;
          if (dq < warpRq) {
            const inf = Math.exp(-dq / (warpRq * 0.42));
            const ux = px - F.x;
            const uy = py - F.y;
            const ul = Math.hypot(ux, uy) || 1;
            px += (ux / ul) * inf * o.warpStrength;
            py += (uy / ul) * inf * o.warpStrength;
            if (inf > bright) bright = inf;
          }
        }
        if (s === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }

      const base = mix(PALETTE.deep, PALETTE.emer, 0.35 + 0.65 * fr);
      const col = mix(base, PALETTE.lime, Math.min(1, bright));
      const alpha = edge * (0.15 + 0.6 * bright + 0.09 * (1 - fr)) * prom;
      c.strokeStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${alpha.toFixed(3)})`;
      c.lineWidth = 0.85 + bright * 1.9;
      if (bright > 0.22 && prom > 0.4) {
        c.shadowColor = `rgba(${PALETTE.lime.join(",")},${(bright * 0.62 * prom).toFixed(2)})`;
        c.shadowBlur = 14 * bright;
      } else {
        c.shadowBlur = 0;
      }
      c.stroke();
    }
    c.shadowBlur = 0;

    if (o.well && mouse.active && !reduce && prom > 0.25) {
      const g = c.createRadialGradient(sm.x, sm.y, 0, sm.x, sm.y, warpR);
      g.addColorStop(0, `rgba(${PALETTE.lime.join(",")},${(0.1 * prom).toFixed(3)})`);
      g.addColorStop(0.5, `rgba(${PALETTE.lime.join(",")},${(0.03 * prom).toFixed(3)})`);
      g.addColorStop(1, `rgba(${PALETTE.lime.join(",")},0)`);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }
  }

  let raf = 0;
  let visible = true;
  function loop(now: number) {
    raf = 0;
    // Off screen: park the loop; the observer restarts it on the way back in.
    if (!visible) return;
    if (!document.hidden) draw(now);
    if (!reduce) raf = requestAnimationFrame(loop);
  }
  const start = () => {
    if (!reduce && !raf && visible) raf = requestAnimationFrame(loop);
  };

  resize();
  mouse.x = sm.x = W * 0.6;
  mouse.y = sm.y = H * 0.5;
  // Resizing clears the canvas, so a parked (reduced motion) field redraws once.
  const onResize = () => {
    resize();
    if (reduce) draw(performance.now());
  };
  window.addEventListener("resize", onResize, { passive: true });
  const resizes = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  resizes?.observe(container);
  const views =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          start();
        })
      : null;
  views?.observe(container);
  if (!coarse) {
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave, { passive: true });
  }
  draw(performance.now());
  start();

  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      resizes?.disconnect();
      views?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      canvas.remove();
    },
  };
}
