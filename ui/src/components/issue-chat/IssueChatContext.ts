import { createContext } from "react";
import type {
  FeedbackDataSharingPreference,
  Agent,
  FeedbackVoteValue,
  SuccessfulRunHandoffState,
} from "@greatstone/shared";
import type {
  SuggestTasksInteraction,
  RequestConfirmationInteraction,
  RequestCheckboxConfirmationInteraction,
  AskUserQuestionsInteraction,
  AskUserQuestionsAnswer,
  IssueThreadInteraction,
  RequestItemVerdictsInteraction,
  RequestItemVerdictValue,
} from "../../lib/issue-thread-interactions";
import type { MarkdownExternalReferenceMap } from "../MarkdownBody";
import type { CompanyUserProfile } from "../../lib/company-members";

export interface IssueChatMessageContext {
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  feedbackTermsUrl: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onStopRun?: (runId: string) => Promise<void>;
  stopRunLabel?: string;
  stoppingRunLabel?: string;
  stopRunVariant?: "stop" | "pause";
  runFinalizationActions?: readonly IssueChatRunFinalizationAction[];
  onInterruptQueued?: (runId: string | null) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  onDeleteComment?: (commentId: string) => Promise<void> | void;
  onImageClick?: (src: string) => void;
  onAcceptInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
    rememberAction?: boolean,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  /** New task-view composer takeover action. The classic thread does not render it. */
  onSkipInteraction?: (
    interaction: IssueThreadInteraction,
  ) => Promise<void> | void;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: {
      id: string;
      verdict: RequestItemVerdictValue;
      reason?: string;
    }[],
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  issueStatus?: string;
  /**
   * Current assignee. Agent comments from anyone else are cross-issue writes, so
   * they carry a "for {user}" attribution chip (the open cross-task write design (attribution)).
   */
  issueAssigneeAgentId?: string | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  externalReferences?: MarkdownExternalReferenceMap;
  /** Linkify `PAP-C7` case chips in comment bodies (experimental Cases flag). */
  linkCaseReferences?: boolean;
}

export const IssueChatCtx = createContext<IssueChatMessageContext>({
  feedbackDataSharingPreference: "prompt",
  feedbackTermsUrl: null,
  issueStatus: undefined,
  successfulRunHandoff: null,
});

export const AGENT_COMMENT_BUBBLE_WIDTH_CLASS =
  "max-w-(--sz-calc-7) sm:max-w-(--pct-85)";

export type IssueChatRunFinalizationAction = {
  id: "cancel" | "done";
  label: string;
  pendingLabel: string;
  onSelect: (runId: string) => Promise<void> | void;
  isPending?: boolean;
  disabled?: boolean;
};
