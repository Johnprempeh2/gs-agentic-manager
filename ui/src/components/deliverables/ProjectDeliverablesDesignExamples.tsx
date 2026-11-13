import { useMemo, useState } from "react";
import { groupDeliverableDocuments } from "@greatstone/shared";
import type { Deliverable, DeliverableVersion } from "@/api/deliverables";
import { DeliverableStageBadge } from "./DeliverableBadges";
import {
  filterProjectDeliverables,
  ProjectDeliverableCard,
  ProjectDeliverableFilters,
  sortLatestFirst,
  type ProjectDeliverableFilter,
} from "./ProjectDeliverables";
import { DeliverableProjectAssignment, DeliverableVersionTimeline, OldVersionBanner } from "./DeliverableVersionTimeline";

// Demo data for the design guide and Storybook: no client names.

const PROJECT = { id: "p-demo", name: "Discovery portal" };

function demoDeliverable(overrides: Partial<Deliverable> & Pick<Deliverable, "id" | "title">): Deliverable {
  return {
    companyId: "c-demo",
    key: overrides.id,
    version: 1,
    versionCount: 1,
    summary: null,
    kind: "report",
    brand: "Greatstone",
    status: "final",
    stage: "delivered",
    confidentiality: "client",
    attachmentId: "a-demo",
    external: false,
    url: null,
    screenshotPath: null,
    screenshotCapturedAt: null,
    linkCheck: null,
    restricted: false,
    contentType: "text/html",
    byteSize: 1024,
    originalFilename: null,
    contentPath: "#",
    openPath: "#",
    downloadPath: "#",
    issue: { id: "i-demo", identifier: "GRE-101", title: "Demo task" },
    project: PROJECT,
    projectMoved: false,
    clientCase: { id: "case-demo", name: "Example Client Ltd" },
    createdByAgent: { id: "agent-demo", name: "Lintel" },
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    lastOpenedAt: null,
    href: "#",
    appPath: "#",
    ...overrides,
  };
}

export const DEMO_PROJECT_DELIVERABLES: Deliverable[] = [
  demoDeliverable({ id: "d-portal", title: "Discovery portal with the North Star instrument", kind: "mockup", version: 3, versionCount: 3, createdAt: "2026-11-12T16:20:00.000Z" }),
  demoDeliverable({ id: "d-findings", title: "Executive discovery findings", kind: "report", version: 2, versionCount: 2, stage: "approved", createdAt: "2026-11-11T09:05:00.000Z" }),
  demoDeliverable({ id: "d-proposal", title: "Commercial proposal", kind: "proposal", stage: "in_review", createdAt: "2026-11-09T14:00:00.000Z", createdByAgent: null }),
  demoDeliverable({ id: "d-notes", title: "Interview synthesis notes", kind: "brief", stage: "draft", status: "draft", confidentiality: "internal", createdAt: "2026-11-08T11:30:00.000Z" }),
  demoDeliverable({ id: "d-pack", title: "Engagement pack", kind: "deck", version: 4, versionCount: 4, createdAt: "2026-11-05T08:00:00.000Z" }),
];

export const DEMO_PORTAL_VERSIONS: DeliverableVersion[] = [
  { id: "v3", version: 3, attachmentId: "a3", title: "Discovery portal", status: "final", contentPath: "#", downloadPath: "#", createdAt: "2026-11-12T16:20:00.000Z", createdByAgent: { id: "agent-demo", name: "Lintel" }, summary: "Adds the North Star instrument to the overview.", reviewNote: null },
  { id: "v2", version: 2, attachmentId: "a2", title: "Discovery portal", status: "final", contentPath: "#", downloadPath: "#", createdAt: "2026-11-06T10:00:00.000Z", createdByAgent: { id: "agent-demo", name: "Lintel" }, summary: null, reviewNote: "The North Star instrument is missing from the overview. Please add it before the session." },
  { id: "v1", version: 1, attachmentId: "a1", title: "Discovery portal", status: "draft", contentPath: "#", downloadPath: "#", createdAt: "2026-10-28T15:45:00.000Z", createdByAgent: null, summary: "First cut for internal review.", reviewNote: null },
];

export function ProjectDeliverablesDesignExamples() {
  const [filter, setFilter] = useState<ProjectDeliverableFilter>("all");
  const [shownId, setShownId] = useState("v1");
  const documents = useMemo(() => sortLatestFirst(groupDeliverableDocuments(DEMO_PROJECT_DELIVERABLES)), []);
  const counts = {
    all: documents.length,
    delivered: filterProjectDeliverables(documents, "delivered").length,
    client_facing: filterProjectDeliverables(documents, "client_facing").length,
  };
  const shown = filterProjectDeliverables(documents, filter);
  const shownVersion = DEMO_PORTAL_VERSIONS.find((version) => version.id === shownId)?.version ?? 3;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stage badge</h4>
        <div className="flex flex-wrap gap-2">
          <DeliverableStageBadge stage="draft" />
          <DeliverableStageBadge stage="in_review" />
          <DeliverableStageBadge stage="approved" />
          <DeliverableStageBadge stage="delivered" />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project Deliverables tab</h4>
        <ProjectDeliverableFilters value={filter} counts={counts} onChange={setFilter} />
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((document) => (
            <ProjectDeliverableCard key={document.key} deliverable={document.latest} earlierCopies={document.older.length} onOpen={() => undefined} />
          ))}
        </div>
      </div>

      <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border">
          <OldVersionBanner shownVersion={shownVersion} latestVersion={3} onViewLatest={() => setShownId("v3")} />
          <div className="flex min-h-40 items-center justify-center bg-muted/40 p-6 text-sm text-muted-foreground">
            Release {shownVersion} preview
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <DeliverableProjectAssignment
            title="Discovery portal"
            project={PROJECT}
            clientName="Example Client Ltd"
            projects={[PROJECT, { id: "p-site", name: "Company website" }, { id: "p-ops", name: "Operations review" }]}
            onMove={() => undefined}
          />
          <DeliverableVersionTimeline versions={DEMO_PORTAL_VERSIONS} shownId={shownId} onView={setShownId} />
        </div>
      </div>
    </div>
  );
}
