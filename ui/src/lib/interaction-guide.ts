/**
 * Step-by-step guide helpers for interaction cards (GRE-916).
 *
 * When an agent asks the board to do several steps, the help text is long and
 * carries commands to copy. The card shows a short summary and an
 * "Open step-by-step guide" link; the guide shows the full steps one block at
 * a time. These helpers decide when the guide is needed, derive the summary
 * and split the markdown into numbered steps. They never change the text the
 * agent sent — they only choose where it is shown.
 */

/** Help text longer than this opens in the guide instead of inline. */
export const GUIDE_LENGTH_THRESHOLD = 300;
/** A derived summary longer than this is cut to its first sentence. */
export const GUIDE_SUMMARY_MAX_LENGTH = 200;

const FENCE_PATTERN = /^\s{0,3}(```|~~~)/;
const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const STEP_MARKER_PATTERN = /^\s{0,3}(?:\*\*|__)?\s*step\s+\d+\b/i;
const ORDERED_ITEM_PATTERN = /^(\d{1,3})[.)]\s+/;

export interface GuideStep {
  /** Heading or "Step N" line, shown as the step title. */
  title: string | null;
  /** The step body as markdown. */
  body: string;
}

export interface GuideSections {
  /** Text before the first step (context, not a step). */
  intro: string;
  steps: GuideStep[];
  /** Text after the last step (closing context, not a step). */
  outro: string;
}

/** Line indexes that sit inside a fenced code block (fence lines included). */
function fencedLineMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const match = line.match(FENCE_PATTERN);
    if (open) {
      mask.push(true);
      if (match && match[1] === open) open = null;
      continue;
    }
    if (match) {
      open = match[1];
      mask.push(true);
      continue;
    }
    mask.push(false);
  }
  return mask;
}

function hasCodeFence(markdown: string): boolean {
  return markdown.split("\n").some((line) => FENCE_PATTERN.test(line));
}

function countOutsideFences(markdown: string, pattern: RegExp): number {
  const lines = markdown.split("\n");
  const fenced = fencedLineMask(lines);
  return lines.filter((line, index) => !fenced[index] && pattern.test(line)).length;
}

/**
 * True when help text should open in the guide: it is long, carries a code
 * block, or is a numbered list of steps. Short text stays inline.
 */
export function needsInteractionGuide(markdown: string | null | undefined): boolean {
  const text = markdown?.trim() ?? "";
  if (!text) return false;
  if (text.length > GUIDE_LENGTH_THRESHOLD) return true;
  if (hasCodeFence(text)) return true;
  if (countOutsideFences(text, STEP_MARKER_PATTERN) >= 2) return true;
  return countOutsideFences(text, /^\s{0,3}\d{1,3}[.)]\s+\S/) >= 2;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cutToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length <= max) return sentence;
  const clipped = text.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/**
 * The one- or two-line summary shown on the card: the first plain paragraph
 * before any step, list or code block, cut to its first sentence when long.
 * Falls back to a step count when the text opens straight into the steps.
 */
export function interactionGuideSummary(markdown: string): string {
  const { intro, steps } = splitInteractionGuide(markdown);
  // Text with no step boundaries is one untitled step: summarise it directly.
  const source = intro || (steps.length === 1 && !steps[0].title ? steps[0].body : "");
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(
      (paragraph) =>
        paragraph.length > 0
        && !FENCE_PATTERN.test(paragraph)
        && !/^\s{0,3}([-*+]|\d{1,3}[.)])\s/.test(paragraph)
        && !/^>/.test(paragraph),
    );
  const first = paragraphs[0];
  if (first) {
    const lines = first.split("\n").filter((line) => !FENCE_PATTERN.test(line));
    const plain = stripInlineMarkdown(
      lines.map((line) => line.replace(HEADING_PATTERN, "$1")).join(" "),
    );
    if (plain) return cutToSentence(plain, GUIDE_SUMMARY_MAX_LENGTH);
  }
  const count = steps.length;
  if (count > 1) return `Follow the ${count} steps in the guide.`;
  return "Open the guide to read the full steps.";
}

function stepTitleFromLine(line: string): string {
  const heading = line.match(HEADING_PATTERN);
  const raw = heading ? heading[1] : line;
  return stripInlineMarkdown(raw).replace(/[:\s]+$/, "");
}

/** Removes up to `width` leading spaces so nested fences and lists still parse. */
function dedent(line: string, width: number): string {
  let index = 0;
  while (index < width && line[index] === " ") index += 1;
  return line.slice(index);
}

function trimBlankLines(lines: string[]): string {
  return lines.join("\n").replace(/^\s*\n/, "").trimEnd();
}

/**
 * Splits guide markdown into numbered steps. Step boundaries, in order of
 * preference: headings, "Step N" lines, then top-level numbered list items.
 * Lines inside code blocks never start a step. Text with no boundary is one
 * step with no title.
 */
export function splitInteractionGuide(markdown: string): GuideSections {
  const lines = markdown.replace(/\r\n?/g, "\n").trim().split("\n");
  const fenced = fencedLineMask(lines);
  const findBoundaries = (pattern: RegExp) =>
    lines.flatMap((line, index) => (!fenced[index] && pattern.test(line) ? [index] : []));

  const headingStarts = findBoundaries(/^#{1,6}\s+\S/);
  const markerStarts = findBoundaries(STEP_MARKER_PATTERN);
  const titledStarts = headingStarts.length >= 2
    ? headingStarts
    : markerStarts.length >= 2
      ? markerStarts
      : null;

  if (titledStarts) {
    const intro = trimBlankLines(lines.slice(0, titledStarts[0]));
    const steps = titledStarts.map((start, position) => {
      const end = titledStarts[position + 1] ?? lines.length;
      const firstLine = lines[start];
      const heading = HEADING_PATTERN.test(firstLine);
      // "**Step 1 of 4** — run the script" keeps the text after the marker.
      const markerTail = heading
        ? ""
        : firstLine.replace(/^\s*(\*\*|__)(.+?)\1\s*[:—–-]?\s*/, "").trim();
      const titleSource = heading
        ? firstLine
        : (firstLine.match(/^\s*(\*\*|__)(.+?)\1/)?.[2] ?? firstLine);
      const bodyLines = lines.slice(start + 1, end);
      if (markerTail && markerTail !== firstLine.trim()) bodyLines.unshift(markerTail);
      return { title: stepTitleFromLine(titleSource), body: trimBlankLines(bodyLines) };
    });
    return { intro, steps, outro: "" };
  }

  const itemStarts = findBoundaries(ORDERED_ITEM_PATTERN);
  if (itemStarts.length >= 2) {
    const intro = trimBlankLines(lines.slice(0, itemStarts[0]));
    // The list ends at the first unindented paragraph after a blank line that
    // follows the last item; that text is closing context, not a step.
    const lastStart = itemStarts[itemStarts.length - 1];
    let listEnd = lines.length;
    for (let index = lastStart + 1; index < lines.length; index += 1) {
      if (
        !fenced[index]
        && !fenced[index - 1]
        && lines[index - 1].trim() === ""
        && /^\S/.test(lines[index])
      ) {
        listEnd = index;
        break;
      }
    }
    const steps = itemStarts.map((start, position) => {
      const end = itemStarts[position + 1] ?? listEnd;
      const width = lines[start].match(ORDERED_ITEM_PATTERN)?.[0].length ?? 0;
      const body = [
        lines[start].slice(width),
        ...lines.slice(start + 1, end).map((line) => dedent(line, width)),
      ];
      return { title: null, body: trimBlankLines(body) };
    });
    return { intro, steps, outro: trimBlankLines(lines.slice(listEnd)) };
  }

  return { intro: "", steps: [{ title: null, body: lines.join("\n").trim() }], outro: "" };
}
