/**
 * The words on a copy button that answers in place ("Copy as an update",
 * then "Copied" or "Could not copy").
 *
 * It keeps the width of its resting label while the shorter answer shows, so
 * the button never shrinks on click. On Agents that shrink let the whole
 * toolbar jump up a row for a second and a half.
 */
export function CopyActionLabel({
  copy,
  children,
}: {
  copy: { copied: boolean; failed: boolean };
  children: string;
}) {
  return (
    <span className="gs-stable-label" data-reserve={children}>
      {copy.copied ? "Copied" : copy.failed ? "Could not copy" : children}
    </span>
  );
}
