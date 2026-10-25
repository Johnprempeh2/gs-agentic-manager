import { z } from "zod";
import { DEEP_DIVE_VISIBILITIES, type DeepDiveVisibility } from "./deep-dive.js";

/**
 * Deep Dive boards (GRE-2369): Screens 5 and 6 of the GRE-2327 plan, from the
 * website Deep Dive Portal.
 *
 * Organisation board: units (a tree by `parentId`), the people in them, the
 * people nobody has placed, and the target state worked out from each
 * person's tasks and the fate somebody chose for each task.
 *
 * Process board: processes on a canvas in one lane per offering. Where a card
 * sits is layout, never a claim: an arrow is drawn only where a handoff is
 * recorded, and the only arrows are the recorded handoffs.
 */

export const DEEP_DIVE_UNIT_TYPES = ["company", "division", "department", "team"] as const;
export type DeepDiveUnitType = (typeof DEEP_DIVE_UNIT_TYPES)[number];

export const DEEP_DIVE_PERSON_SIDES = ["client", "greatstone", "third_party"] as const;
export type DeepDivePersonSide = (typeof DEEP_DIVE_PERSON_SIDES)[number];

/** What happens to a task in the target state. "Not decided" until somebody judges it. */
export const DEEP_DIVE_TASK_FATES = [
  "not_decided",
  "eliminated",
  "simplified",
  "digitised",
  "automated",
  "augmented",
  "agentic",
  "moves",
  "stays",
] as const;
export type DeepDiveTaskFate = (typeof DEEP_DIVE_TASK_FATES)[number];

export const DEEP_DIVE_TASK_FATE_LABELS: Record<DeepDiveTaskFate, string> = {
  not_decided: "Not decided",
  eliminated: "Eliminated",
  simplified: "Simplified",
  digitised: "Digitised",
  automated: "Automated",
  augmented: "Augmented",
  agentic: "Agentic",
  moves: "Moves",
  stays: "Stays",
};

export const DEEP_DIVE_TASK_FATE_MEANS: Record<DeepDiveTaskFate, string> = {
  not_decided: "Nobody has judged this yet.",
  eliminated: "The work ceases to exist. Nobody does it.",
  simplified: "It continues with fewer steps, inputs or handoffs. The same people.",
  digitised: "It continues, but the record moves into structured data. The same people.",
  automated: "It continues, run against fixed rules. A system, with no judgement.",
  augmented: "It continues, with a person materially faster or more accurate.",
  agentic: "It continues, with exceptions handled within limits. A system, with bounded judgement.",
  moves: "It continues unchanged, done by somebody else. The business still does it.",
  stays: "Nothing changes.",
};

/** Fates that take the work off the person: these hours count as freed. */
export const DEEP_DIVE_FATES_THAT_REMOVE: ReadonlySet<DeepDiveTaskFate> = new Set(["eliminated", "automated", "agentic"]);
/** Fates that lighten the work but leave it with the person: never counted as freed. */
export const DEEP_DIVE_FATES_THAT_REDUCE: ReadonlySet<DeepDiveTaskFate> = new Set(["simplified", "digitised", "augmented"]);

export const DEEP_DIVE_HOURS_PER_WEEK = 37.5;

/** Card size and spacing on the process board, in board pixels. */
export const DEEP_DIVE_CANVAS = { cardWidth: 220, cardHeight: 96, gapX: 70, gapY: 24, pad: 16, grid: 10, maxXY: 20_000 } as const;

const name = z.string().trim().min(1).max(200);
const note = z.string().trim().max(2_000);
const id = z.string().guid();
const visibility = z.enum(DEEP_DIVE_VISIBILITIES);

// Organisation board -------------------------------------------------------

export const createDeepDiveUnitSchema = z
  .object({
    name,
    unitType: z.enum(DEEP_DIVE_UNIT_TYPES).optional(),
    parentId: id.nullable().optional(),
    headcount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();
export type CreateDeepDiveUnit = z.infer<typeof createDeepDiveUnitSchema>;

export const updateDeepDiveUnitSchema = createDeepDiveUnitSchema
  .partial()
  .extend({
    leadPersonId: id.nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    visibility: visibility.optional(),
  })
  .strict();
export type UpdateDeepDiveUnit = z.infer<typeof updateDeepDiveUnitSchema>;

export const createDeepDivePersonSchema = z
  .object({
    name,
    role: note.max(200).optional(),
    side: z.enum(DEEP_DIVE_PERSON_SIDES).optional(),
    unitId: id.nullable().optional(),
    reportsToId: id.nullable().optional(),
  })
  .strict();
export type CreateDeepDivePerson = z.infer<typeof createDeepDivePersonSchema>;

export const updateDeepDivePersonSchema = createDeepDivePersonSchema
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict();
export type UpdateDeepDivePerson = z.infer<typeof updateDeepDivePersonSchema>;

export const createDeepDiveTaskSchema = z
  .object({
    what: z.string().trim().min(1).max(500),
    hoursPerWeek: z.number().min(0).max(168).nullable().optional(),
    fate: z.enum(DEEP_DIVE_TASK_FATES).optional(),
    why: note.optional(),
  })
  .strict();
export type CreateDeepDiveTask = z.infer<typeof createDeepDiveTaskSchema>;

export const updateDeepDiveTaskSchema = createDeepDiveTaskSchema
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveTask = z.infer<typeof updateDeepDiveTaskSchema>;

export interface DeepDiveUnit {
  id: string;
  name: string;
  unitType: DeepDiveUnitType;
  parentId: string | null;
  leadPersonId: string | null;
  headcount: number | null;
  position: number;
  visibility: DeepDiveVisibility;
}

export interface DeepDivePerson {
  id: string;
  name: string;
  role: string;
  side: DeepDivePersonSide;
  unitId: string | null;
  reportsToId: string | null;
  visibility: DeepDiveVisibility;
}

export interface DeepDiveTask {
  id: string;
  personId: string;
  what: string;
  hoursPerWeek: number | null;
  fate: DeepDiveTaskFate;
  why: string;
  visibility: DeepDiveVisibility;
}

export interface DeepDiveOrgBoard {
  companyId: string;
  units: DeepDiveUnit[];
  people: DeepDivePerson[];
  tasks: DeepDiveTask[];
}

// Process board -------------------------------------------------------------

export const createDeepDiveOfferingSchema = z.object({ name }).strict();
export type CreateDeepDiveOffering = z.infer<typeof createDeepDiveOfferingSchema>;

export const updateDeepDiveOfferingSchema = z
  .object({ name: name.optional(), position: z.number().int().min(0).max(10_000).optional(), visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveOffering = z.infer<typeof updateDeepDiveOfferingSchema>;

export const createDeepDiveProcessSchema = z
  .object({
    name,
    offeringId: id.nullable().optional(),
    runsPersonId: id.nullable().optional(),
    unitId: id.nullable().optional(),
  })
  .strict();
export type CreateDeepDiveProcess = z.infer<typeof createDeepDiveProcessSchema>;

export const updateDeepDiveProcessSchema = createDeepDiveProcessSchema
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveProcess = z.infer<typeof updateDeepDiveProcessSchema>;

const coordinate = z.number().int().min(0).max(DEEP_DIVE_CANVAS.maxXY);

/**
 * Where cards sit. Null x and y put a card back in its automatic place.
 * Layout only: nothing here can draw an arrow. Give both x and y, or neither.
 */
export const saveDeepDiveProcessLayoutSchema = z
  .object({
    positions: z
      .array(
        z
          .object({ processId: id, x: coordinate.nullable(), y: coordinate.nullable() })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type SaveDeepDiveProcessLayout = z.infer<typeof saveDeepDiveProcessLayoutSchema>;

export const recordDeepDiveHandoffSchema = z
  .object({
    fromProcessId: id,
    toProcessId: id,
    /** What is handed over. A handoff with nothing named is not recorded. */
    what: z.string().trim().min(1).max(500),
  })
  .strict();
export type RecordDeepDiveHandoff = z.infer<typeof recordDeepDiveHandoffSchema>;

export const updateDeepDiveHandoffSchema = z
  .object({ what: z.string().trim().min(1).max(500).optional(), visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveHandoff = z.infer<typeof updateDeepDiveHandoffSchema>;

export interface DeepDiveOffering {
  id: string;
  name: string;
  position: number;
  visibility: DeepDiveVisibility;
}

export interface DeepDiveProcess {
  id: string;
  name: string;
  offeringId: string | null;
  runsPersonId: string | null;
  unitId: string | null;
  /** Null until somebody moves the card; then it is placed automatically. Relative to its lane. */
  x: number | null;
  y: number | null;
  visibility: DeepDiveVisibility;
}

export interface DeepDiveHandoff {
  id: string;
  fromProcessId: string;
  toProcessId: string;
  what: string;
  visibility: DeepDiveVisibility;
}

export interface DeepDiveProcessBoard {
  companyId: string;
  offerings: DeepDiveOffering[];
  processes: DeepDiveProcess[];
  handoffs: DeepDiveHandoff[];
  /** For pickers and card labels. */
  people: Pick<DeepDivePerson, "id" | "name">[];
  units: Pick<DeepDiveUnit, "id" | "name">[];
}

// Organisation logic --------------------------------------------------------

export interface DeepDiveUnitNode {
  unit: DeepDiveUnit;
  depth: number;
  children: DeepDiveUnitNode[];
}

/**
 * Units as a forest, ordered by position then name. A unit whose parent is
 * missing shows at the root rather than vanishing; a cycle cannot hang it.
 */
export function deepDiveOrgTree(units: readonly DeepDiveUnit[]): DeepDiveUnitNode[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const kids = new Map<string, DeepDiveUnit[]>();
  const roots: DeepDiveUnit[] = [];
  for (const u of units) {
    if (u.parentId && u.parentId !== u.id && byId.has(u.parentId)) {
      kids.set(u.parentId, [...(kids.get(u.parentId) ?? []), u]);
    } else {
      roots.push(u);
    }
  }
  const order = (a: DeepDiveUnit, b: DeepDiveUnit) => a.position - b.position || a.name.localeCompare(b.name);
  const seen = new Set<string>();
  const build = (u: DeepDiveUnit, depth: number): DeepDiveUnitNode | null => {
    if (seen.has(u.id)) return null;
    seen.add(u.id);
    const children = [...(kids.get(u.id) ?? [])].sort(order).map((c) => build(c, depth + 1)).filter((n): n is DeepDiveUnitNode => !!n);
    return { unit: u, depth, children };
  };
  const forest = [...roots].sort(order).map((u) => build(u, 0)).filter((n): n is DeepDiveUnitNode => !!n);
  // Units caught in a cycle reach no root: show them at the root too.
  for (const u of [...units].sort(order)) {
    if (!seen.has(u.id)) {
      const node = build(u, 0);
      if (node) forest.push(node);
    }
  }
  return forest;
}

/** People nobody has put in a unit (or whose unit is gone). An unplaced person is a question, not a tidy-up. */
export function deepDiveUnplacedPeople<T extends Pick<DeepDivePerson, "unitId">>(people: readonly T[], units: readonly Pick<DeepDiveUnit, "id">[]): T[] {
  const ids = new Set(units.map((u) => u.id));
  return people.filter((p) => !p.unitId || !ids.has(p.unitId));
}

export interface DeepDivePersonLoad {
  person: DeepDivePerson;
  tasks: DeepDiveTask[];
  hoursNow: number;
  hoursAfter: number;
  hoursFreed: number;
  hoursMoved: number;
  hoursLightened: number;
  /** Tasks with no hours recorded, so a partial count never reads as a total. */
  hoursUnknown: number;
  undecided: number;
}

export interface DeepDiveTargetState {
  people: DeepDivePersonLoad[];
  tasks: number;
  undecided: number;
  hoursNow: number;
  hoursFreed: number;
  hoursMoved: number;
  hoursLightened: number;
  hoursUnknown: number;
  headcountNow: number;
  /** Whole people freed, rounded down; only from recorded hours. */
  peopleFreed: number;
  headcountAfter: number;
  restsOn: { peopleMapped: number; ofPeople: number; hoursPerWeek: number };
}

/**
 * The target state, from tasks somebody recorded and fates somebody chose.
 * Conservative: only eliminated, automated and agentic work counts as freed;
 * moved work stays in the business and is reported beside the saving. Nothing
 * is inferred from a job title.
 */
export function deepDiveTargetState(board: Pick<DeepDiveOrgBoard, "units" | "people" | "tasks">, hoursPerWeek = DEEP_DIVE_HOURS_PER_WEEK): DeepDiveTargetState {
  const clientPeople = board.people.filter((p) => p.side === "client");
  const hours = (list: DeepDiveTask[]) => list.reduce((n, t) => n + (t.hoursPerWeek ?? 0), 0);
  const rows = clientPeople.map((person): DeepDivePersonLoad => {
    const tasks = board.tasks.filter((t) => t.personId === person.id);
    const freed = tasks.filter((t) => DEEP_DIVE_FATES_THAT_REMOVE.has(t.fate));
    return {
      person,
      tasks,
      hoursNow: hours(tasks),
      hoursAfter: hours(tasks.filter((t) => !DEEP_DIVE_FATES_THAT_REMOVE.has(t.fate))),
      hoursFreed: hours(freed),
      hoursMoved: hours(tasks.filter((t) => t.fate === "moves")),
      hoursLightened: hours(tasks.filter((t) => DEEP_DIVE_FATES_THAT_REDUCE.has(t.fate))),
      hoursUnknown: tasks.filter((t) => t.hoursPerWeek === null).length,
      undecided: tasks.filter((t) => t.fate === "not_decided").length,
    };
  });
  const sum = (key: "hoursNow" | "hoursFreed" | "hoursMoved" | "hoursLightened" | "hoursUnknown" | "undecided") =>
    rows.reduce((n, r) => n + r[key], 0);
  const headcountNow = board.units.reduce((n, u) => n + (u.headcount ?? 0), 0) || clientPeople.length;
  const hoursFreed = sum("hoursFreed");
  const peopleFreed = hoursPerWeek > 0 ? Math.floor(hoursFreed / hoursPerWeek) : 0;
  return {
    people: rows,
    tasks: rows.reduce((n, r) => n + r.tasks.length, 0),
    undecided: sum("undecided"),
    hoursNow: sum("hoursNow"),
    hoursFreed,
    hoursMoved: sum("hoursMoved"),
    hoursLightened: sum("hoursLightened"),
    hoursUnknown: sum("hoursUnknown"),
    headcountNow,
    peopleFreed,
    headcountAfter: Math.max(0, headcountNow - peopleFreed),
    restsOn: { peopleMapped: rows.filter((r) => r.tasks.length > 0).length, ofPeople: clientPeople.length, hoursPerWeek },
  };
}

// Process board logic -------------------------------------------------------

export interface DeepDiveLane {
  /** Null for the lane of processes no offering names. */
  offering: DeepDiveOffering | null;
  processes: DeepDiveProcess[];
}

/** One lane per offering in order, then one for processes no offering names (only if any). */
export function deepDiveProcessLanes(board: Pick<DeepDiveProcessBoard, "offerings" | "processes">): DeepDiveLane[] {
  const offerings = [...board.offerings].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const ids = new Set(offerings.map((o) => o.id));
  const lanes: DeepDiveLane[] = offerings.map((offering) => ({
    offering,
    processes: board.processes.filter((p) => p.offeringId === offering.id),
  }));
  const unnamed = board.processes.filter((p) => !p.offeringId || !ids.has(p.offeringId));
  if (unnamed.length > 0) lanes.push({ offering: null, processes: unnamed });
  return lanes;
}

/**
 * Where a card sits in its lane when nobody has moved it: columns by how far
 * downstream the recorded handoffs put it.
 */
export function deepDiveAutoLayout(
  processes: readonly Pick<DeepDiveProcess, "id" | "name">[],
  handoffs: readonly Pick<DeepDiveHandoff, "fromProcessId" | "toProcessId">[],
): Map<string, { x: number; y: number }> {
  const { cardWidth, cardHeight, gapX, gapY, pad } = DEEP_DIVE_CANVAS;
  const ids = new Set(processes.map((p) => p.id));
  const next = new Map<string, string[]>();
  for (const h of handoffs) {
    if (ids.has(h.fromProcessId) && ids.has(h.toProcessId) && h.fromProcessId !== h.toProcessId) {
      next.set(h.fromProcessId, [...(next.get(h.fromProcessId) ?? []), h.toProcessId]);
    }
  }
  const depth = new Map<string, number>();
  const walk = (pid: string, d: number, path: Set<string>) => {
    if (path.has(pid) || (depth.get(pid) ?? -1) >= d) return;
    depth.set(pid, d);
    path.add(pid);
    for (const n of next.get(pid) ?? []) walk(n, d + 1, path);
    path.delete(pid);
  };
  const fedInto = new Set([...next.values()].flat());
  for (const p of processes) if (!fedInto.has(p.id)) walk(p.id, 0, new Set());
  for (const p of processes) if (!depth.has(p.id)) walk(p.id, 0, new Set());
  const columns: Pick<DeepDiveProcess, "id" | "name">[][] = [];
  for (const p of processes) (columns[depth.get(p.id) ?? 0] ??= []).push(p);
  const out = new Map<string, { x: number; y: number }>();
  columns.forEach((column, cx) =>
    (column ?? []).sort((a, b) => a.name.localeCompare(b.name)).forEach((p, cy) => {
      out.set(p.id, { x: pad + cx * (cardWidth + gapX), y: pad + cy * (cardHeight + gapY) });
    }),
  );
  return out;
}

export interface DeepDiveArrow {
  handoffId: string;
  fromProcessId: string;
  toProcessId: string;
  what: string;
}

/**
 * The arrows on the process board. Each one is a recorded handoff between two
 * processes on the board; nothing else draws an arrow, not position, not
 * order, not offering.
 */
export function deepDiveProcessArrows(board: Pick<DeepDiveProcessBoard, "processes" | "handoffs">): DeepDiveArrow[] {
  const ids = new Set(board.processes.map((p) => p.id));
  return board.handoffs
    .filter((h) => h.fromProcessId !== h.toProcessId && ids.has(h.fromProcessId) && ids.has(h.toProcessId))
    .map((h) => ({ handoffId: h.id, fromProcessId: h.fromProcessId, toProcessId: h.toProcessId, what: h.what }));
}
