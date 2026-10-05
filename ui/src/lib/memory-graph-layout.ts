/**
 * Small deterministic force layout for the Memory graph (GRE-865). Same input,
 * same picture: start on a circle, then a fixed number of repulsion / spring
 * steps. Good for the few hundred permitted records a screen shows; no library.
 */

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, LayoutPoint>;
  width: number;
  height: number;
}

const ITERATIONS = 240;
const REPULSION = 14000;
const SPRING_LENGTH = 170;
const SPRING_STRENGTH = 0.04;
const CENTER_PULL = 0.008;
const PADDING = 48;

export function layoutMemoryGraph(nodeIds: string[], links: Array<{ fromId: string; toId: string }>): LayoutResult {
  const ids = [...nodeIds].sort();
  const count = ids.length;
  const positions = new Map<string, LayoutPoint>();
  if (count === 0) return { positions, width: 0, height: 0 };

  const radius = Math.max(80, count * 14);
  ids.forEach((id, index) => {
    const angle = (2 * Math.PI * index) / count;
    positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  const springs = links.filter((link) => positions.has(link.fromId) && positions.has(link.toId) && link.fromId !== link.toId);

  for (let step = 0; step < ITERATIONS; step += 1) {
    const cooling = 1 - step / ITERATIONS;
    const force = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));

    for (let i = 0; i < count; i += 1) {
      const a = positions.get(ids[i])!;
      for (let j = i + 1; j < count; j += 1) {
        const b = positions.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) {
          dx = 0.1 * (i - j);
          dy = 0.1;
          distSq = dx * dx + dy * dy;
        }
        const push = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * push;
        const fy = (dy / dist) * push;
        force.get(ids[i])!.x += fx;
        force.get(ids[i])!.y += fy;
        force.get(ids[j])!.x -= fx;
        force.get(ids[j])!.y -= fy;
      }
    }

    for (const link of springs) {
      const a = positions.get(link.fromId)!;
      const b = positions.get(link.toId)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const pull = (dist - SPRING_LENGTH) * SPRING_STRENGTH;
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      force.get(link.fromId)!.x += fx;
      force.get(link.fromId)!.y += fy;
      force.get(link.toId)!.x -= fx;
      force.get(link.toId)!.y -= fy;
    }

    for (const id of ids) {
      const point = positions.get(id)!;
      const f = force.get(id)!;
      f.x -= point.x * CENTER_PULL;
      f.y -= point.y * CENTER_PULL;
      const limit = 18 * cooling + 1;
      point.x += Math.max(-limit, Math.min(limit, f.x));
      point.y += Math.max(-limit, Math.min(limit, f.y));
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of positions.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  for (const point of positions.values()) {
    point.x = point.x - minX + PADDING;
    point.y = point.y - minY + PADDING;
  }
  return { positions, width: maxX - minX + PADDING * 2, height: maxY - minY + PADDING * 2 };
}
