// Report for scripts/beta-switch-age.sh: how long each beta (experimental)
// switch has been in its current state, from the
// `instance.settings.experimental_updated` activity rows.
//
//   node scripts/beta-switch-age.mjs <settings.json> <activity.json> [--limit <n>]
//
// Pure: reads the two files the shell script fetched and prints a table.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RULE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One row per switch in `settings`.
 * `activity` is the activity list as the API returns it (any order).
 * `truncated` means the API hit its row limit, so older changes may be missing.
 */
export function switchAges(settings, activity, { now = Date.now(), truncated = false } = {}) {
  const events = activity
    .filter((row) => row?.action === "instance.settings.experimental_updated")
    .map((row) => ({
      at: new Date(row.createdAt).getTime(),
      changedKeys: Array.isArray(row.details?.changedKeys) ? row.details.changedKeys : [],
      state: row.details?.experimental ?? {},
    }))
    .filter((event) => Number.isFinite(event.at))
    .sort((a, b) => a.at - b.at);

  return Object.keys(settings)
    .filter((key) => key !== "managedKeys")
    .sort()
    .map((key) => {
      const value = settings[key];
      const state = typeof value === "boolean" ? (value ? "on" : "off") : JSON.stringify(value);
      const changes = events.filter((event) => event.changedKeys.includes(key));
      const row = { key, state, onSince: "unknown", days: null, ruleMet: "unknown" };
      if (typeof value !== "boolean") return { ...row, ruleMet: "n/a" };
      // The last logged value must match the current one; if not, the change
      // happened without a log row and we do not guess.
      if (changes.length === 0 || changes.at(-1).state[key] !== value) return row;
      // Start of the trailing run of changes that left the switch in its
      // current state (re-saving the same value does not reset the clock).
      let start = changes.length - 1;
      while (start > 0 && changes[start - 1].state[key] === value) start -= 1;
      const since = changes[start].at;
      const days = Math.floor((now - since) / DAY_MS);
      // With a cut-off history the run may have started before the oldest row.
      const openStart = truncated && start === 0;
      const onSince = openStart ? `before ${isoDay(since)}` : isoDay(since);
      if (!value) return { ...row, onSince: "-", days: null, ruleMet: "no" };
      const met = days >= RULE_DAYS;
      return {
        ...row,
        onSince,
        days: openStart ? `${days}+` : days,
        ruleMet: met ? "yes" : openStart ? "unknown" : "no",
      };
    });
}

export function formatTable(rows) {
  const header = ["switch", "state", "on since", "days on", "2-week rule met"];
  const body = rows.map((r) => [r.key, r.state, r.onSince, r.days === null ? "-" : String(r.days), r.ruleMet]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

function main(argv) {
  const [settingsPath, activityPath, ...rest] = argv;
  if (!settingsPath || !activityPath) {
    console.error("usage: beta-switch-age.mjs <settings.json> <activity.json> [--limit <n>]");
    process.exit(2);
  }
  const limitIndex = rest.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const activity = JSON.parse(readFileSync(activityPath, "utf8"));
  const truncated = activity.length >= limit;
  console.log(formatTable(switchAges(settings, activity, { truncated })));
  if (truncated) {
    console.log(`\nnote: the activity log returned its ${limit}-row limit; older changes are not shown.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
