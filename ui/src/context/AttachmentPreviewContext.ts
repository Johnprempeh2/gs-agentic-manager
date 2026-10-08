import { createContext } from "react";
import type { AttachmentPreviewTarget } from "../lib/attachment-preview";

/**
 * Opens an attachment in the issue's preview panel (GRE-1036). Returns false
 * when the file cannot be previewed, so the link keeps its normal behaviour.
 * Null outside the issue view: links there are unchanged.
 */
export const AttachmentPreviewContext = createContext<
  ((target: AttachmentPreviewTarget) => boolean) | null
>(null);
