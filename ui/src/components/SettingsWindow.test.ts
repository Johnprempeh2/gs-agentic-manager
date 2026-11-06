import { describe, expect, it } from "vitest";
import { settingsWindowPath } from "./SettingsWindow";

describe("settingsWindowPath", () => {
  it("opens in-app paths only", () => {
    expect(settingsWindowPath("gsam-settings:/company/settings/secrets")).toBe("/company/settings/secrets");
    expect(settingsWindowPath("gsam-settings://evil.example")).toBeNull();
    expect(settingsWindowPath("gsam-settings:/\\evil.example")).toBeNull();
    expect(settingsWindowPath("gsam-settings:javascript:alert(1)")).toBeNull();
    expect(settingsWindowPath("https://example.com")).toBeNull();
  });
});
