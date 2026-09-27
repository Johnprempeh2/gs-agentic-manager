import type { CSSProperties } from "react";
import { Link } from "@/lib/router";
import { X } from "lucide-react";
import {
  useToastActions,
  useToastState,
  type ToastItem,
} from "../context/ToastContext";

// Floating glass for every tone: the tone is carried by the rail, the dot and
// the lifetime hairline (gs-toast[data-tone]), never by tinting the text.
function AnimatedToast({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  return (
    <li
      data-tone={toast.tone}
      className="gs-glass-float gs-toast pointer-events-auto rounded-lg border text-foreground"
      style={{ "--gs-toast-ttl": `${toast.ttlMs}ms` } as CSSProperties}
    >
      <div className="flex items-start gap-3 py-2.5 pl-4 pr-3">
        <span className="gs-toast-dot mt-1.5 h-2 w-2 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">{toast.title}</p>
          {toast.body && (
            <p className="mt-1 text-xs leading-4 text-muted-foreground">
              {toast.body}
            </p>
          )}
          {toast.action &&
            (toast.action.onClick ? (
              <button
                type="button"
                onClick={() => {
                  toast.action?.onClick?.();
                  onDismiss(toast.id);
                }}
                className="mt-2 inline-flex text-xs font-medium underline decoration-(--gs-nav-marker) decoration-2 underline-offset-4"
              >
                {toast.action.label}
              </button>
            ) : toast.action.href ? (
              <Link
                to={toast.action.href}
                onClick={() => onDismiss(toast.id)}
                className="mt-2 inline-flex text-xs font-medium underline decoration-(--gs-nav-marker) decoration-2 underline-offset-4"
              >
                {toast.action.label}
              </Link>
            ) : null)}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          className="gs-press mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <span aria-hidden="true" className="gs-toast-timer" />
    </li>
  );
}

export function ToastViewport() {
  const toasts = useToastState();
  const { dismissToast } = useToastActions();

  if (toasts.length === 0) return null;

  return (
    <aside
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-(--toast-mobile-bottom) left-3 right-3 z-(--z-120) max-w-sm px-1 md:bottom-3"
    >
      <ol className="flex w-full flex-col-reverse gap-2">
        {toasts.map((toast) => (
          <AnimatedToast
            key={toast.id}
            toast={toast}
            onDismiss={dismissToast}
          />
        ))}
      </ol>
    </aside>
  );
}
