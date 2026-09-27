// Safari guesses contact AutoFill from a field's placeholder, label, name and
// id. Words like "title" (job title) or "name" make it drop the user's
// contacts under the box, and it ignores `autocomplete="off"` for contacts.
// Safari does skip any field whose name contains "search", so free-text boxes
// get a `search_*` name alongside `autoComplete="off"` for other browsers.
// Keep contact words ("title", "name", "company", ...) out of `field`.
export function noContactAutofill(field: string) {
  return {
    autoComplete: "off",
    name: `search_${field}`,
  } as const;
}
