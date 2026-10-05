import { ISSUE_WORK_MODES, hasMcpToolHints } from "@greatstone/shared";
import { describe, expect, it } from "vitest";
import { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../services/connection-tool-definitions.js";
import { projectToolDefinitions } from "../services/project-tools.js";

describe("our own MCP tools declare effect hints", () => {
  it("covers every runtime connection tool", () => {
    expect(RUNTIME_CONNECTION_TOOL_DEFINITIONS.filter((tool) => !hasMcpToolHints(tool.annotations))).toEqual([]);
    expect(RUNTIME_CONNECTION_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.annotations.readOnlyHint])).toEqual([
      ["connections_search", true],
      ["connection_request", false],
    ]);
  });

  it("covers every project tool in every work mode", () => {
    for (const mode of ISSUE_WORK_MODES) {
      const tools = projectToolDefinitions(mode, true);
      expect(tools.filter((tool) => !hasMcpToolHints(tool.annotations)).map((tool) => tool.name)).toEqual([]);
    }
    const effects = Object.fromEntries(
      projectToolDefinitions("standard", true).map((tool) => [tool.name, tool.annotations]),
    );
    expect(effects.list_projects).toMatchObject({ readOnlyHint: true });
    expect(effects.list_project_repositories).toMatchObject({ readOnlyHint: true });
    expect(effects.create_project).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(effects.create_task).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });
});
