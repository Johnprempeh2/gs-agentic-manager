import { Plus } from "lucide-react";
import type { DragEvent } from "react";
import { IssueAttachmentsSection } from "../../components/IssueAttachmentsSection";
import { IssueDocumentsSection } from "../../components/IssueDocumentsSection";
import { IssuePlanDecompositionsSection } from "../../components/IssuePlanDecompositionsSection";
import { IssueOutputSection } from "../../components/issue-output/IssueOutputSection";
import { IssuesList } from "../../components/IssuesList";
import { Button } from "@/components/ui/button";
import { buildSubIssueDefaultsForViewer } from "../../lib/subIssueDefaults";
import type { Issue, Agent } from "@greatstone/shared";
import { IssueSectionSkeleton } from "./IssueDetailLoading";
import { FEEDBACK_TERMS_URL } from "./helpers";
import { useThreadMutations } from "./useThreadMutations";
import { useIssueDetailQueries } from "./useIssueDetailQueries";
import type { Project, FeedbackVote, IssueAttachment, IssueWorkProduct } from "@greatstone/shared";
import type { IssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import type { Location } from "@/lib/router";
import type { MentionOption } from "@/components/MarkdownEditor";
import type { IssueExternalObjectsResult } from "@/hooks/useIssueExternalObjects";
import type { UseMutationResult } from "@tanstack/react-query";
import type { JSX, Dispatch, SetStateAction } from "react";
import type { CompanyUserProfile } from "@/lib/company-members";
import type { GalleryMediaItem } from "@/components/ImageGalleryModal";

export type IssueDetailClassicSectionsProps = {
  taskChatShellEnabled: boolean;
  showRichSubIssuesSection: boolean;
  childIssues: Issue[];
  childIssuesLoading: boolean;
  agents: Agent[] | undefined;
  projects: Project[] | undefined;
  liveIssueIds: Set<string>;
  mutedChildIssueIds: Set<string>;
  childPauseBadgeById: Map<string, string>;
  issue: Issue;
  resolvedIssueDetailState: IssueDetailLocationState | null;
  location: Location<any>;
  currentUserId: string | null;
  handleChildIssueUpdate: (id: string, data: Record<string, unknown>) => void;
  openNewSubIssue: () => void;
  showPlanDecompositionsSection: boolean;
  agentMap: Map<string, Agent>;
  session: ReturnType<typeof useIssueDetailQueries>["session"];
  feedbackVotes: FeedbackVote[] | undefined;
  feedbackDataSharingPreference: "allowed" | "not_allowed" | "prompt";
  mentionOptions: MentionOption[];
  externalObjectsState: IssueExternalObjectsResult;
  uploadAttachment: UseMutationResult<IssueAttachment, Error, File, unknown>;
  feedbackVoteMutation: ReturnType<typeof useThreadMutations>["feedbackVoteMutation"];
  hasAttachments: boolean;
  attachmentUploadButton: JSX.Element;
  userProfileMap: Map<string, CompanyUserProfile>;
  workProducts: IssueWorkProduct[] | undefined;
  mediaGalleryItems: GalleryMediaItem[];
  setGalleryIndex: Dispatch<SetStateAction<number>>;
  setGalleryOpen: Dispatch<SetStateAction<boolean>>;
  attachmentsInitialLoading: boolean;
  attachmentList: IssueAttachment[];
  attachmentError: string | null;
  attachmentDragActive: boolean;
  deleteAttachment: UseMutationResult<{ ok: true; }, Error, string, unknown>;
  setAttachmentDragActive: Dispatch<SetStateAction<boolean>>;
  handleAttachmentDrop: (evt: DragEvent<HTMLDivElement>) => Promise<void>;
};

export function IssueDetailClassicSections({
  taskChatShellEnabled,
  showRichSubIssuesSection,
  childIssues,
  childIssuesLoading,
  agents,
  projects,
  liveIssueIds,
  mutedChildIssueIds,
  childPauseBadgeById,
  issue,
  resolvedIssueDetailState,
  location,
  currentUserId,
  handleChildIssueUpdate,
  openNewSubIssue,
  showPlanDecompositionsSection,
  agentMap,
  session,
  feedbackVotes,
  feedbackDataSharingPreference,
  mentionOptions,
  externalObjectsState,
  uploadAttachment,
  feedbackVoteMutation,
  hasAttachments,
  attachmentUploadButton,
  userProfileMap,
  workProducts,
  mediaGalleryItems,
  setGalleryIndex,
  setGalleryOpen,
  attachmentsInitialLoading,
  attachmentList,
  attachmentError,
  attachmentDragActive,
  deleteAttachment,
  setAttachmentDragActive,
  handleAttachmentDrop,
}: IssueDetailClassicSectionsProps) {
  return (
    <>
      {taskChatShellEnabled ? null : showRichSubIssuesSection ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Sub-tasks
            </h3>
          </div>
          <IssuesList
            issues={childIssues}
            isLoading={childIssuesLoading}
            agents={agents}
            projects={projects}
            liveIssueIds={liveIssueIds}
            mutedIssueIds={mutedChildIssueIds}
            issueBadgeById={childPauseBadgeById}
            projectId={issue.projectId ?? undefined}
            viewStateKey={`paperclip:issue-detail:${issue.id}:subissues-view`}
            issueLinkState={resolvedIssueDetailState ?? location.state}
            searchFilters={{
              descendantOf: issue.id,
              includeBlockedBy: true,
            }}
            searchWithinLoadedIssues
            baseCreateIssueDefaults={buildSubIssueDefaultsForViewer(
              issue,
              currentUserId,
            )}
            createIssueLabel="Sub-task"
            defaultSortField="workflow"
            showProgressSummary
            parentIssueIdForCostSummary={issue.id}
            onUpdateIssue={handleChildIssueUpdate}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          <Button
            variant="outline"
            size="sm"
            onClick={openNewSubIssue}
            className="shrink-0 shadow-none"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Sub-task
          </Button>
        </div>
      )}

      {!taskChatShellEnabled && showPlanDecompositionsSection ? (
        <IssuePlanDecompositionsSection
          issueId={issue.id}
          issueIdentifier={issue.identifier}
          agentMap={agentMap}
        />
      ) : null}

      {/* Flag ON: attachments/work products/workspace live in the properties
      pane (Artifacts tab) — the center column belongs to the thread. */}
      {taskChatShellEnabled ? null : (
        <IssueDocumentsSection
          issue={issue}
          canDeleteDocuments={Boolean(session?.user?.id)}
          canManageDocumentLocks={Boolean(session?.user?.id)}
          feedbackVotes={feedbackVotes}
          feedbackDataSharingPreference={feedbackDataSharingPreference}
          feedbackTermsUrl={FEEDBACK_TERMS_URL}
          mentions={mentionOptions}
          externalReferences={
            externalObjectsState.isEnabled
              ? externalObjectsState.markdownReferences
              : undefined
          }
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
          onVote={async (revisionId, vote, options) => {
            await feedbackVoteMutation.mutateAsync({
              targetType: "issue_document_revision",
              targetId: revisionId,
              vote,
              reason: options?.reason,
              allowSharing: options?.allowSharing,
              sharingPreferenceAtSubmit: feedbackDataSharingPreference,
            });
          }}
          extraActions={!hasAttachments ? attachmentUploadButton : null}
          agentMap={agentMap}
          userProfileMap={userProfileMap}
        />
      )}

      {taskChatShellEnabled ? null : (
        <IssueOutputSection
          workProducts={workProducts}
          onMediaClick={(item) => {
            const meta = item.metadata;
            if (!meta) return;
            const idx = mediaGalleryItems.findIndex(
              (galleryItem) =>
                galleryItem.contentPath === meta.contentPath ||
                galleryItem.id === `work-product-${item.id}` ||
                galleryItem.id === meta.attachmentId,
            );
            setGalleryIndex(idx >= 0 ? idx : 0);
            setGalleryOpen(true);
          }}
        />
      )}

      {taskChatShellEnabled ? null : attachmentsInitialLoading ? (
        <IssueSectionSkeleton titleWidth="w-24" rows={2} />
      ) : hasAttachments ? (
        <IssueAttachmentsSection
          attachments={attachmentList}
          uploadButton={attachmentUploadButton}
          error={attachmentError}
          dragActive={attachmentDragActive}
          deletePending={deleteAttachment.isPending}
          onDelete={(attachmentId) => deleteAttachment.mutate(attachmentId)}
          onImageClick={(attachment) => {
            const idx = mediaGalleryItems.findIndex(
              (a) => a.id === attachment.id,
            );
            setGalleryIndex(idx >= 0 ? idx : 0);
            setGalleryOpen(true);
          }}
          onDragEnter={(evt) => {
            evt.preventDefault();
            setAttachmentDragActive(true);
          }}
          onDragOver={(evt) => {
            evt.preventDefault();
            setAttachmentDragActive(true);
          }}
          onDragLeave={(evt) => {
            if (
              evt.currentTarget.contains(evt.relatedTarget as Node | null)
            )
              return;
            setAttachmentDragActive(false);
          }}
          onDrop={(evt) => void handleAttachmentDrop(evt)}
        />
      ) : null}
    </>
  );
}
