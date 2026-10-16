import { describe, expect, it } from "vitest";
import type { Project } from "@greatstone/shared";
import { projectTargetLabel, projectsForUpdate, projectsToCsv, projectsUpdateText } from "./projects-text";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Website relaunch",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    taskCount: 0,
    archivedAt: null,
    ...overrides,
  } as Project;
}

const lookups = { agentName: (id: string) => (id === "a1" ? "Ridge" : null) };

describe("projectsUpdateText", () => {
  it("lists open projects, busiest first, with tasks, target date and lead", () => {
    const text = projectsUpdateText(
      [
        project({ id: "p2", name: "Hire a designer", status: "planned", targetDate: "2026-10-20" }),
        project({ leadAgentId: "a1", targetDate: "2026-10-06", taskCount: 12 }),
        project({ id: "p3", name: "Old idea", status: "cancelled" }),
        project({ id: "p4", name: "Archived", archivedAt: new Date() }),
      ],
      lookups,
      "2026-10-16",
    );
    expect(text).toBe(
      [
        "Projects update, 16 Oct",
        "2 projects: 1 in progress, 1 planned.",
        "",
        "• Website relaunch: In progress, 12 tasks, due 6 Oct, 10 days late, led by Ridge",
        "• Hire a designer: Planned, due 20 Oct, 4 days to go",
      ].join("\n"),
    );
  });

  it("says so when no projects are open", () => {
    expect(projectsUpdateText([project({ status: "cancelled" })], lookups, "2026-10-16")).toBe(
      "Projects update, 16 Oct\n\nNo projects are open.",
    );
  });
});

describe("projectTargetLabel", () => {
  it("counts down for open projects and shows the date only once completed", () => {
    const now = new Date(2026, 9, 16, 12);
    expect(projectTargetLabel({ targetDate: "2026-10-06", status: "in_progress" }, now)).toBe("6 Oct, 10 days late");
    expect(projectTargetLabel({ targetDate: "2026-10-06", status: "completed" }, now)).toBe("6 Oct");
    expect(projectTargetLabel({ targetDate: null, status: "planned" }, now)).toBeNull();
  });
});

describe("projectsToCsv", () => {
  it("writes one row per open project", () => {
    const csv = projectsToCsv(
      [project({ leadAgentId: "a1", targetDate: "2026-12-31", taskCount: 3, description: "New site, new copy" })],
      lookups,
    );
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Project,Status,Tasks,Target date,Lead,Description");
    expect(lines[1]).toBe('Website relaunch,In progress,3,2026-12-31,Ridge,"New site, new copy"');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("keeps completed projects after open ones", () => {
    const order = projectsForUpdate([
      project({ id: "done", name: "Done", status: "completed" }),
      project({ id: "live", name: "Live" }),
    ]).map((p) => p.id);
    expect(order).toEqual(["live", "done"]);
  });
});
