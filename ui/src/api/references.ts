import { api } from "./client";

/** A reference studio image (2 Nov 2026): what people and agents point at when instructing work. */
export interface ReferenceItem {
  id: string;
  assetId: string;
  title: string;
  notes: string | null;
  tags: string[];
  contentType: string | null;
  contentPath: string;
  createdAt: string;
  updatedAt: string;
}

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/references`;

export const referencesApi = {
  list: (companyId: string) => api.get<ReferenceItem[]>(base(companyId)),
  create: (companyId: string, body: { assetId: string; title: string; notes?: string | null; tags?: string[] }) =>
    api.post<ReferenceItem>(base(companyId), body),
  update: (companyId: string, id: string, body: { title?: string; notes?: string | null; tags?: string[] }) =>
    api.patch<ReferenceItem>(`${base(companyId)}/${encodeURIComponent(id)}`, body),
  archive: (companyId: string, id: string) => api.delete<void>(`${base(companyId)}/${encodeURIComponent(id)}`),
};

/** The line a picked reference adds to an instruction: the agent fetches the image at the path. */
export function referenceInstruction(ref: ReferenceItem) {
  const note = ref.notes?.trim().replace(/[.!?]+$/, "");
  return `Use the reference "${ref.title}" (image: ${ref.contentPath})${note ? `: ${note}` : ""}.`;
}
