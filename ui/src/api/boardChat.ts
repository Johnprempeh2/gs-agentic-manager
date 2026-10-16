import { api } from "./client";

/** Board chat (conference room). Files on a message are attachments on its standing issue. */
export const boardChatApi = {
  /** The board conversation's issue, created on first use, so files can be attached before the first message. */
  ensureIssue: (companyId: string) => api.post<{ issueId: string }>("/board/chat/issue", { companyId }),
};

/** Files one board chat message can carry (the server refuses more). */
export const MAX_BOARD_CHAT_ATTACHMENTS = 5;
