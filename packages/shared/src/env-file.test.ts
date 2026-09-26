import { describe, expect, it } from "vitest";
import { encodeEnvValue, updateEnvFileContents } from "./env-file.js";

describe("env file editor", () => {
  it("pins minimal and JSON value encoding", () => {
    expect(encodeEnvValue("plain-value", "minimal")).toBe("plain-value");
    expect(encodeEnvValue("#439edb", "minimal")).toBe('"#439edb"');
    expect(encodeEnvValue("plain-value", "json")).toBe('"plain-value"');
  });

  it("preserves unrelated content and CRLF while updating every stale duplicate", () => {
    const original = [
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      "export GSAM_HOME = '/old path'  # managed path",
      "GSAM_DUPLICATE=stale",
      'GSAM_DUPLICATE="current"',
      "TRAILING=untouched",
      "",
    ].join("\r\n");

    const updated = updateEnvFileContents(
      original,
      {
        GSAM_HOME: "/new path",
        GSAM_DUPLICATE: "current",
        GSAM_WORKTREE_COLOR: "#439edb",
      },
      { valueEncoding: "minimal" },
    );

    expect(updated).toBe([
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      'export GSAM_HOME = "/new path"  # managed path',
      "GSAM_DUPLICATE=current",
      'GSAM_DUPLICATE="current"',
      "TRAILING=untouched",
      'GSAM_WORKTREE_COLOR="#439edb"',
      "",
    ].join("\r\n"));
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("uses JSON encoding for changed values without re-encoding current assignments", () => {
    const original = [
      "GSAM_CURRENT=plain-value",
      "GSAM_CHANGED=old",
      "UNKNOWN=\"operator value\"",
      "",
    ].join("\n");

    expect(
      updateEnvFileContents(
        original,
        {
          GSAM_CURRENT: "plain-value",
          GSAM_CHANGED: "new",
          GSAM_ADDED: "added",
        },
        { valueEncoding: "json" },
      ),
    ).toBe([
      "GSAM_CURRENT=plain-value",
      'GSAM_CHANGED="new"',
      'UNKNOWN="operator value"',
      'GSAM_ADDED="added"',
      "",
    ].join("\n"));
  });

  it("does not treat an unquoted dotenv comment as the managed value", () => {
    expect(
      updateEnvFileContents(
        ["GSAM_COLOR=#439edb", "GSAM_HOME=old# keep this comment"].join("\n"),
        {
          GSAM_COLOR: "#439edb",
          GSAM_HOME: "new",
        },
        { valueEncoding: "minimal" },
      ),
    ).toBe(
      ['GSAM_COLOR="#439edb"#439edb', "GSAM_HOME=new# keep this comment"].join("\n"),
    );
  });

  it("is a no-op when every managed duplicate is already current", () => {
    const original = [
      "export GSAM_HOME = '/same path' # first",
      'GSAM_HOME="/same path"',
      "UNKNOWN=value",
    ].join("\n");

    expect(updateEnvFileContents(original, { GSAM_HOME: "/same path" })).toBe(original);
  });
});
