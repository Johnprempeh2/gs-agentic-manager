import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link } from "@/lib/router";

/** Window event any screen can fire to open the shortcuts sheet. */
export const OPEN_SHORTCUTS_EVENT = "gsam:open-shortcuts";

export function openShortcutsSheet() {
  window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}

function isMacPlatform() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

const PROFILE_SETTINGS_PATH = "/company/settings/instance/profile";

interface ShortcutEntry {
  keys: string[];
  label: string;
  /** Render keys as a simultaneous chord (joined with "+") rather than a
   *  "then" sequence. */
  combo?: boolean;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

/** Shortcuts that always work, even when single-key shortcuts are off. */
function alwaysOnSection(mod: string): ShortcutSection {
  return {
    title: "Search and Ask",
    shortcuts: [
      { keys: [mod, "K"], label: "Search everything, or type a command", combo: true },
      { keys: [mod, "J"], label: "Ask Everest a question", combo: true },
      { keys: ["Tab"], label: "In search: actions for the selected task" },
      { keys: ["?"], label: "Show this sheet" },
    ],
  };
}

const sections: ShortcutSection[] = [
  {
    title: "Inbox",
    shortcuts: [
      { keys: ["j"], label: "Move down" },
      { keys: ["↓"], label: "Move down" },
      { keys: ["k"], label: "Move up" },
      { keys: ["↑"], label: "Move up" },
      { keys: ["←"], label: "Collapse selected group" },
      { keys: ["→"], label: "Expand selected group" },
      { keys: ["Enter"], label: "Open selected item" },
      { keys: ["a"], label: "Archive item" },
      { keys: ["y"], label: "Archive item" },
      { keys: ["r"], label: "Mark as read" },
      { keys: ["U"], label: "Mark as unread" },
    ],
  },
  {
    title: "Task detail",
    shortcuts: [
      { keys: ["y"], label: "Quick-archive back to inbox" },
      { keys: ["g", "i"], label: "Go to inbox" },
      { keys: ["g", "c"], label: "Focus comment composer" },
    ],
  },
  {
    title: "Decisions",
    shortcuts: [
      { keys: ["j"], label: "Move down" },
      { keys: ["↓"], label: "Move down" },
      { keys: ["k"], label: "Move up" },
      { keys: ["↑"], label: "Move up" },
      { keys: ["Enter"], label: "Open or close selected decision" },
      { keys: ["x"], label: "Dismiss selected decision" },
    ],
  },
  {
    title: "Global",
    shortcuts: [
      { keys: ["/"], label: "Search current page or quick search" },
      { keys: ["c"], label: "New task" },
      { keys: ["["], label: "Toggle sidebar" },
      { keys: ["]"], label: "Toggle panel" },
    ],
  },
];

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-(--shadow-extract-10)">
      {children}
    </kbd>
  );
}

function ShortcutSectionBlock({ section }: { section: ShortcutSection }) {
  return (
    <div className="px-5 py-3">
      <h3 className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wider text-muted-foreground">
        {section.title}
      </h3>
      <div className="space-y-1.5">
        {section.shortcuts.map((shortcut) => (
          <div
            key={shortcut.label + shortcut.keys.join()}
            className="flex items-center justify-between gap-4"
          >
            <span className="text-sm text-foreground/90">{shortcut.label}</span>
            <div className="flex items-center gap-1">
              {shortcut.keys.map((key, i) => (
                <span key={key} className="flex items-center gap-1">
                  {i > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {shortcut.combo ? "+" : "then"}
                    </span>
                  )}
                  <KeyCap>{key}</KeyCap>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function KeyboardShortcutsCheatsheetContent({
  singleKeysEnabled = true,
  onNavigate,
}: {
  /** Whether the person turned on single-key shortcuts in their profile. */
  singleKeysEnabled?: boolean;
  onNavigate?: () => void;
} = {}) {
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  return (
    <>
      <div className="max-h-(--sz-480px) divide-y divide-border overflow-y-auto border-t border-border">
        {[alwaysOnSection(mod)].map((section) => (
          <ShortcutSectionBlock key={section.title} section={section} />
        ))}
        {singleKeysEnabled ? null : (
          <p className="px-5 py-3 text-sm text-muted-foreground" data-testid="shortcuts-off-note">
            The single-key shortcuts below are off.{" "}
            <Link to={PROFILE_SETTINGS_PATH} onClick={onNavigate} className="font-medium text-foreground underline underline-offset-2">
              Turn them on in your profile
            </Link>
            .
          </p>
        )}
        {sections.map((section) => (
          <ShortcutSectionBlock key={section.title} section={section} />
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          Press <KeyCap>Esc</KeyCap> to close &middot; Shortcuts are disabled in text fields
        </p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
  singleKeysEnabled = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  singleKeysEnabled?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent singleKeysEnabled={singleKeysEnabled} onNavigate={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
