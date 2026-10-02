import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_BRAND_NAME } from "./client-brand";

const CONNECTION_SCREEN_ROOTS = [
  "../features/connections",
  "../pages/apps",
  "../pages/tools/connection-dialogs.tsx",
  "../components/chat/ExternallyConnectedTaskBanner.tsx",
  "../connect-flow-preview-main.tsx",
];

function sourceFiles(relativePath: string): URL[] {
  const url = new URL(relativePath, import.meta.url);
  if (!statSync(url).isDirectory()) return [url];
  return readdirSync(url).flatMap((entry) => sourceFiles(`${relativePath}/${entry}`));
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("client brand on connection screens (GRE-340)", () => {
  it("names Greatstone", () => {
    expect(CLIENT_BRAND_NAME).toBe("Greatstone");
  });

  it("keeps the platform name out of connection screen copy", () => {
    const offenders = CONNECTION_SCREEN_ROOTS.flatMap(sourceFiles)
      .filter((url) => /\.tsx?$/.test(url.pathname) && !/\.test\.tsx?$/.test(url.pathname))
      .flatMap((url) =>
        stripComments(readFileSync(url, "utf8"))
          .split("\n")
          // "GS Agentic Manager Review" is the GitHub check name the server publishes.
          .filter((line) => /GS Agentic Manager(?! Review)/.test(line))
          .map((line) => `${url.pathname.split("/ui/src/")[1]}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});
