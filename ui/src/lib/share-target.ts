import type { NewIssueDefaults } from "../context/DialogContext";

/** The longest title a shared item gives a new task; the rest stays in the description. */
export const SHARED_TITLE_MAX = 120;

function clean(value: string | null): string {
  return (value ?? "").trim();
}

function shorten(line: string): string {
  return line.length > SHARED_TITLE_MAX ? `${line.slice(0, SHARED_TITLE_MAX - 3).trimEnd()}...` : line;
}

/**
 * New task defaults from the query of `/issues/new`: the home screen
 * shortcut sends none, and sharing a page or text to GSAM from another app
 * sends `title`, `text` and `url` (the manifest's `share_target`). Phones
 * differ: some put the link in `text`, some leave `title` empty.
 */
export function sharedTaskDefaults(search: string): NewIssueDefaults {
  const params = new URLSearchParams(search);
  const title = clean(params.get("title"));
  const text = clean(params.get("text"));
  const url = clean(params.get("url"));
  if (!title && !text && !url) return {};

  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const heading = title || firstLine || url;
  const description = [text && text !== heading ? text : "", url && url !== heading && !text.includes(url) ? url : ""]
    .filter(Boolean)
    .join("\n\n");
  if (description) return { title: shorten(heading), description };
  return heading.length > SHARED_TITLE_MAX ? { title: shorten(heading), description: heading } : { title: heading };
}
