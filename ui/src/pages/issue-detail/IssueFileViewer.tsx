import { useEffect } from "react";
import { useRequiredFileViewer } from "../../context/FileViewerContext";
import { FileViewerSheet } from "../../components/FileViewerSheet";

export function IssueFileViewer({
  issueId,
  companyId,
  promptOpen,
  onPromptOpenChange,
  useSidePanel = false,
}: {
  issueId: string;
  companyId: string;
  promptOpen: boolean;
  onPromptOpenChange: (next: boolean) => void;
  useSidePanel?: boolean;
}) {
  const viewer = useRequiredFileViewer();

  useEffect(() => {
    if (!useSidePanel || !promptOpen) return;
    viewer.openBrowse();
    onPromptOpenChange(false);
  }, [onPromptOpenChange, promptOpen, useSidePanel, viewer]);

  const open = viewer.state !== null || viewer.browse || promptOpen;
  const showPromptWhenEmpty =
    (promptOpen || viewer.browse) && viewer.state === null;

  useEffect(() => {
    if (useSidePanel) return;
    if (!promptOpen) return;
    if (viewer.state === null && !viewer.browse) return;
    onPromptOpenChange(false);
  }, [
    onPromptOpenChange,
    promptOpen,
    useSidePanel,
    viewer.browse,
    viewer.state,
  ]);

  if (useSidePanel) return null;

  return (
    <FileViewerSheet
      issueId={issueId}
      companyId={companyId}
      open={open}
      showPromptWhenEmpty={showPromptWhenEmpty}
      onOpenChange={(next) => {
        if (!next) {
          onPromptOpenChange(false);
          // Clears any file view and browse state from the URL.
          viewer.close();
        }
      }}
    />
  );
}
