import type { ReactNode } from "react";
import { IssueGalleryContext } from "../../context/IssueGalleryContext";
import { AttachmentPreviewContext } from "../../context/AttachmentPreviewContext";
import type { AttachmentPreviewTarget } from "../../lib/attachment-preview";

/**
 * The page-level handlers the issue side panel needs. It renders outside the
 * page tree, so the media gallery and attachment preview are passed in here.
 */
export function IssuePanelContexts({
  openGallery,
  openAttachmentPreview,
  children,
}: {
  openGallery: (src: string) => boolean;
  openAttachmentPreview: (target: AttachmentPreviewTarget) => boolean;
  children: ReactNode;
}) {
  return (
    <IssueGalleryContext.Provider value={openGallery}>
      <AttachmentPreviewContext.Provider value={openAttachmentPreview}>
        {children}
      </AttachmentPreviewContext.Provider>
    </IssueGalleryContext.Provider>
  );
}
