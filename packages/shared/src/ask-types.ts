/**
 * Typed asks: what an agent needs the person to do, not just a yes or no.
 * An agent sets `payload.askType` on a `request_confirmation`; Decisions then
 * names the ask in plain words, offers a one-click answer, and the agent is
 * woken the moment the person answers. Most agent asks for John are one of
 * these (grant access, send a file, sign, confirm something was sent).
 */
export const ASK_TYPES = ["grant_access", "send_file", "sign", "confirm_sent", "decide"] as const;
export type AskType = (typeof ASK_TYPES)[number];

export interface AskTypeCopy {
  /** The chip on the Decisions card. */
  label: string;
  /** The one-click answer when the agent gave no acceptLabel. */
  acceptLabel: string;
  /** The other answer when the agent gave no rejectLabel. */
  rejectLabel: string;
  /** Hint in the decline box. */
  declinePlaceholder: string;
}

export const ASK_TYPE_COPY: Record<AskType, AskTypeCopy> = {
  grant_access: {
    label: "Access needed",
    acceptLabel: "Access granted",
    rejectLabel: "I can't grant it",
    declinePlaceholder: "Why not, or who can grant it",
  },
  send_file: {
    label: "File needed",
    acceptLabel: "File sent",
    rejectLabel: "I don't have it",
    declinePlaceholder: "Where the agent can find it, or who has it",
  },
  sign: {
    label: "Signature needed",
    acceptLabel: "Signed",
    rejectLabel: "Not signing",
    declinePlaceholder: "What must change first",
  },
  confirm_sent: {
    label: "Did you send it?",
    acceptLabel: "Yes, I sent it",
    rejectLabel: "Not yet",
    declinePlaceholder: "When you will send it",
  },
  decide: {
    label: "Your call",
    acceptLabel: "Yes",
    rejectLabel: "No",
    declinePlaceholder: "What you want instead",
  },
};

export function isAskType(value: unknown): value is AskType {
  return typeof value === "string" && (ASK_TYPES as readonly string[]).includes(value);
}

/** The ask type on an interaction payload, or null. */
export function readAskType(payload: unknown): AskType | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { askType?: unknown }).askType;
  return isAskType(value) ? value : null;
}
