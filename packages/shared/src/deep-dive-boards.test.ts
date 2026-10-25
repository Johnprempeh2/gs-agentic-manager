import { describe, expect, it } from "vitest";
import {
  deepDiveAutoLayout,
  deepDiveOrgTree,
  deepDiveProcessArrows,
  deepDiveProcessLanes,
  deepDiveTargetState,
  type DeepDiveHandoff,
  type DeepDivePerson,
  type DeepDiveProcess,
  type DeepDiveTask,
  type DeepDiveUnit,
} from "./deep-dive-boards.js";

const unit = (id: string, parentId: string | null = null, extra: Partial<DeepDiveUnit> = {}): DeepDiveUnit => ({
  id, name: id, unitType: "team", parentId, leadPersonId: null, headcount: null, position: 0, visibility: "internal", ...extra,
});
const process = (id: string, offeringId: string | null = null, extra: Partial<DeepDiveProcess> = {}): DeepDiveProcess => ({
  id, name: id, offeringId, runsPersonId: null, unitId: null, x: null, y: null, visibility: "internal", ...extra,
});
const handoff = (id: string, fromProcessId: string, toProcessId: string): DeepDiveHandoff => ({
  id, fromProcessId, toProcessId, what: `${fromProcessId} to ${toProcessId}`, visibility: "internal",
});

describe("deepDiveOrgTree", () => {
  it("nests units by parent and shows orphans and cycles at the root without hanging", () => {
    const tree = deepDiveOrgTree([unit("a"), unit("b", "a"), unit("orphan", "gone"), unit("x", "y"), unit("y", "x")]);
    expect(tree.map((n) => n.unit.id)).toEqual(["a", "orphan", "x"]);
    expect(tree[0]!.children.map((n) => n.unit.id)).toEqual(["b"]);
    expect(tree[2]!.children.map((n) => n.unit.id)).toEqual(["y"]);
  });
});

describe("deepDiveTargetState", () => {
  it("counts only removed work as freed, reports moved work beside it, and rounds people down", () => {
    const people: DeepDivePerson[] = [
      { id: "p1", name: "A", role: "", side: "client", unitId: null, reportsToId: null, visibility: "internal" },
      { id: "p2", name: "B", role: "", side: "greatstone", unitId: null, reportsToId: null, visibility: "internal" },
    ];
    const task = (fate: DeepDiveTask["fate"], hoursPerWeek: number | null, personId = "p1"): DeepDiveTask => ({
      id: `${fate}-${hoursPerWeek}`, personId, what: fate, hoursPerWeek, fate, why: "", visibility: "internal",
    });
    const state = deepDiveTargetState({
      units: [unit("u", null, { headcount: 4 })],
      people,
      tasks: [task("automated", 30), task("eliminated", 10), task("moves", 15), task("augmented", 5), task("not_decided", null), task("automated", 40, "p2")],
    });
    expect(state).toMatchObject({
      hoursNow: 60, hoursFreed: 40, hoursMoved: 15, hoursLightened: 5, hoursUnknown: 1, undecided: 1,
      headcountNow: 4, peopleFreed: 1, headcountAfter: 3, restsOn: { peopleMapped: 1, ofPeople: 1 },
    });
  });
});

describe("process board", () => {
  it("gives one lane per offering in order, then one for processes no offering names", () => {
    const lanes = deepDiveProcessLanes({
      offerings: [
        { id: "o2", name: "Second", position: 1, visibility: "internal" },
        { id: "o1", name: "First", position: 0, visibility: "internal" },
      ],
      processes: [process("a", "o1"), process("b", null), process("c", "o2")],
    });
    expect(lanes.map((l) => [l.offering?.id ?? null, l.processes.map((p) => p.id)])).toEqual([
      ["o1", ["a"]],
      ["o2", ["c"]],
      [null, ["b"]],
    ]);
  });

  it("draws an arrow for each recorded handoff and for nothing else", () => {
    const processes = [process("a", "o1", { x: 0, y: 0 }), process("b", "o1", { x: 300, y: 0 }), process("c", "o2", { x: 600, y: 0 })];
    // Cards in a row, in lanes, with saved positions: still no arrow.
    expect(deepDiveProcessArrows({ processes, handoffs: [] })).toEqual([]);
    const arrows = deepDiveProcessArrows({
      processes,
      handoffs: [handoff("h1", "a", "b"), handoff("h2", "a", "gone"), handoff("h3", "c", "c")],
    });
    expect(arrows).toEqual([{ handoffId: "h1", fromProcessId: "a", toProcessId: "b", what: "a to b" }]);
  });

  it("places untouched cards in columns by recorded handoffs, surviving a cycle", () => {
    const layout = deepDiveAutoLayout(
      [process("a"), process("b"), process("c"), process("d")],
      [handoff("1", "a", "b"), handoff("2", "b", "c"), handoff("3", "c", "b")],
    );
    expect(layout.get("a")!.x).toBeLessThan(layout.get("b")!.x);
    expect(layout.get("b")!.x).toBeLessThan(layout.get("c")!.x);
    expect(layout.get("d")!.x).toBe(layout.get("a")!.x);
  });
});
