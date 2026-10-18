import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** True where the device has a share sheet (phones, and some desktop browsers). */
export function canShareText(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * "Share": hands text to the phone's own share sheet (WhatsApp, Messages,
 * email), so an update can go to a partner in two taps. Hidden where the
 * device has no share sheet; Copy covers those.
 */
export function ShareTextButton({ title, getText, label = "Share" }: { title: string; getText: () => string; label?: string }) {
  const [failed, setFailed] = useState(false);
  if (!canShareText()) return null;

  async function share() {
    setFailed(false);
    try {
      await navigator.share({ title, text: getText() });
    } catch (error) {
      // Closing the share sheet is a choice, not a failure.
      if ((error as { name?: string } | null)?.name !== "AbortError") setFailed(true);
    }
  }

  return (
    <Button variant="outline" size="sm" title="Send this from your phone's share sheet" onClick={() => void share()}>
      <Share2 className="size-3.5" />
      {failed ? "Could not share" : label}
    </Button>
  );
}
