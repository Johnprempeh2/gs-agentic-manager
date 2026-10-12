import type { Deliverable } from "./deliverable.js";

// Client files (GRE-1311): each client page has an Evidence list (the
// client's own material) and a Deliverables list (what we made for them).

export const CLIENT_EVIDENCE_KINDS = ["attachment", "document", "link"] as const;
export type ClientEvidenceKind = (typeof CLIENT_EVIDENCE_KINDS)[number];

export interface ClientFileSourceIssue {
  id: string;
  identifier: string | null;
  title: string;
  /** In-app link to the task, e.g. /GRE/issues/GRE-12. */
  path: string;
}

export interface ClientFilePerson {
  type: "agent" | "user";
  id: string;
  name: string | null;
}

export interface ClientEvidenceItem {
  id: string;
  caseId: string;
  kind: ClientEvidenceKind;
  title: string;
  note: string | null;
  /** Short label for the list: "PDF", "Link", "Document", ... */
  typeLabel: string;
  contentType: string | null;
  byteSize: number | null;
  originalFilename: string | null;
  attachmentId: string | null;
  documentId: string | null;
  documentKey: string | null;
  /** External address for links. Never set for files. */
  url: string | null;
  /** In-app API path that returns the file or document body. Null for links. */
  contentPath: string | null;
  downloadPath: string | null;
  /** Where the UI opens the item: the file, the document on its task, or the link. */
  openPath: string;
  sourceIssue: ClientFileSourceIssue | null;
  addedBy: ClientFilePerson | null;
  createdAt: string;
}

/** A task attachment or document in the client's scope that is not yet in Evidence. */
export interface ClientEvidenceCandidate {
  kind: Exclude<ClientEvidenceKind, "link">;
  attachmentId: string | null;
  documentId: string | null;
  title: string;
  typeLabel: string;
  sourceIssue: ClientFileSourceIssue;
  createdAt: string;
}

export interface ClientEvidenceCandidatesResponse {
  candidates: ClientEvidenceCandidate[];
}

export interface ClientFilesClientSummary {
  id: string;
  title: string;
  pipelineId: string;
}

export interface ClientFilesResponse {
  clients: ClientFilesClientSummary[];
  evidence: ClientEvidenceItem[];
  deliverables: Deliverable[];
}
