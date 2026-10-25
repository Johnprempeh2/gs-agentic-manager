import type { DeepDiveVisibility } from "../deep-dive.js";
import type {
  ClientEvidenceItem,
  ClientEvidenceKind,
  ClientFilePerson,
  ClientFilesClientSummary,
} from "./client-files.js";
import type { ClientDocumentRequest } from "./client-journey.js";

// Deep Dive evidence and files (GRE-2395): one client file linked to many Deep
// Dive items. A link points at a file we hold or at a document we asked the
// client for (held once received, missing until then).

export interface DeepDiveItemFileLink {
  id: string;
  /** The Deep Dive item (case) the file is linked to. */
  caseId: string;
  /** Set for a file we hold. */
  evidenceId: string | null;
  /** Set for a document request; held once it has a file. */
  documentRequestId: string | null;
  visibility: DeepDiveVisibility;
  linkedBy: ClientFilePerson | null;
  linkedAt: string;
}

/** GET /api/companies/:companyId/deep-dive/files — the screen in one read. */
export interface DeepDiveFilesResponse {
  /** The client the deep dive record is about; null until a person chooses one. */
  client: ClientFilesClientSummary | null;
  /** Clients a person may choose from. */
  clients: ClientFilesClientSummary[];
  /** The client's files, with where each came from, who added it and when. */
  evidence: ClientEvidenceItem[];
  /** The documents asked of the client, received or not. */
  requests: ClientDocumentRequest[];
  /** Every link of this company's Deep Dive items to this client's files. */
  links: DeepDiveItemFileLink[];
}

/** What a client may see of a Shared link on a Shared item: no staff names or internal ids. */
export interface SharedDeepDiveFile {
  linkId: string;
  itemId: string;
  title: string;
  /** The kind of file held; null while a requested document is missing. */
  kind: ClientEvidenceKind | null;
  status: "held" | "missing";
  /** When the file was added; null while missing. */
  heldAt: string | null;
}
