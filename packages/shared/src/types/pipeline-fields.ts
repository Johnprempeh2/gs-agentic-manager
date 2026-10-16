import type { PipelineFieldType } from "../pipeline-fields.js";

/** A typed field declared on a pipeline (GRE-1075). Cases hold the value in `fields.<key>`. */
export interface PipelineFieldDefinition {
  id: string;
  companyId: string;
  pipelineId: string;
  /** Fixed once created, so stored case values keep their meaning. */
  key: string;
  label: string;
  description: string | null;
  /** Fixed once created. */
  type: PipelineFieldType;
  required: boolean;
  /** Choices for `select` and `multi_select`; empty for other types. */
  options: string[];
  position: number;
  /** Archived fields are no longer checked or shown; case values stay. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
