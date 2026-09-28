// "Finish before update" (GRE-121). An agent sets it on its own running run
// while it is mid-commit, mid-migration or similar; the board can set or clear
// it on any run. A release from the app holds new runs, then waits only for
// running runs with this flag (or the board overrides); every other running run
// goes through the hot restart.
//
// The flags live in one small JSON file next to the release jobs, not in the
// database: a flag only matters while its run runs, and live-release.ts drops
// the flags of runs that stopped.
import fs from "node:fs";
import path from "node:path";

export interface RunUpdateFlag {
  runId: string;
  companyId: string;
  agentId: string;
  reason: string | null;
  flaggedAt: string;
  /** "agent:<id>" or "user:<id>". */
  flaggedBy: string;
}

export function createRunUpdateFlagStore(file: string) {
  const read = (): Record<string, RunUpdateFlag> => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, RunUpdateFlag>) : {};
    } catch {
      return {};
    }
  };
  const write = (flags: Record<string, RunUpdateFlag>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(flags, null, 2)}\n`);
    fs.renameSync(tmp, file);
  };
  return {
    list: (): RunUpdateFlag[] => Object.values(read()),
    set: (runId: string, flag: Omit<RunUpdateFlag, "runId">): RunUpdateFlag => {
      const flags = read();
      flags[runId] = { runId, ...flag };
      write(flags);
      return flags[runId]!;
    },
    clear: (runId: string) => {
      const flags = read();
      if (!(runId in flags)) return;
      delete flags[runId];
      write(flags);
    },
  };
}
