import {
  addPromptBooster,
  hasStudioCamera,
  STUDIO_APERTURES,
  STUDIO_CAMERAS,
  STUDIO_FOCAL_LENGTHS,
  STUDIO_LENSES,
  STUDIO_PROMPT_BOOSTERS,
  studioCameraLabel,
  type StudioApertureId,
  type StudioCameraId,
  type StudioCameraSettings,
  type StudioFocalLength,
  type StudioLensId,
} from "@greatstone/shared";
import { Camera, Plus } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";

interface StudioCameraFieldsProps {
  idPrefix: string;
  camera: StudioCameraSettings;
  onCameraChange: (camera: StudioCameraSettings) => void;
  disabled?: boolean;
}

/** A ready-made camera set people can start from, so nobody needs to know lenses. */
const CAMERA_LOOKS: ReadonlyArray<{ label: string; camera: StudioCameraSettings }> = [
  { label: "Film still", camera: { camera: "70mm-film", lens: "classic-anamorphic", focalLength: 35, aperture: "f1.4" } },
  { label: "Portrait", camera: { camera: "full-frame-cine", lens: "swirl-bokeh-portrait", focalLength: 85, aperture: "f1.4" } },
  { label: "Product advert", camera: { camera: "large-format", lens: "clinical-sharp-prime", focalLength: 50, aperture: "f11" } },
  { label: "Retro", camera: { camera: "16mm-film", lens: "70s-cinema-prime", focalLength: 24, aperture: "f4" } },
];

function sameCamera(a: StudioCameraSettings, b: StudioCameraSettings) {
  return a.camera === b.camera && a.lens === b.lens && a.focalLength === b.focalLength && a.aperture === b.aperture;
}

/**
 * Cinema camera picks for the image studio: camera body, lens, focal length
 * and aperture. Each is optional; the server turns them into prompt words.
 */
export function StudioCameraFields({ idPrefix, camera, onCameraChange, disabled }: StudioCameraFieldsProps) {
  const summary = studioCameraLabel(camera);
  return (
    <details className="rounded-md border border-border p-3" data-testid="studio-camera" open={hasStudioCamera(camera) || undefined}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Camera className="h-4 w-4 text-primary" aria-hidden="true" />
        Camera <span className="font-normal text-muted-foreground">(optional)</span>
        {summary ? <span className="ml-auto truncate text-xs font-normal text-muted-foreground">{summary}</span> : null}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Shoot it like a film. Pick a look, or choose each part yourself.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Camera looks">
          {CAMERA_LOOKS.map((look) => {
            const selected = sameCamera(camera, look.camera);
            return (
              <button
                key={look.label}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onCameraChange(selected ? {} : look.camera)}
                className={
                  selected
                    ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs text-foreground ring-1 ring-primary"
                    : "rounded-full border border-border px-3 py-1 text-xs text-foreground hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                }
              >
                {look.label}
              </button>
            );
          })}
          {hasStudioCamera(camera) ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onCameraChange({})}
              className="rounded-full px-3 py-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Clear camera
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-camera-body`}>
            <span className="block">Camera</span>
            <NativeSelect
              id={`${idPrefix}-camera-body`}
              value={camera.camera ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onCameraChange({ ...camera, camera: (event.target.value || undefined) as StudioCameraId | undefined })
              }
            >
              <option value="">Any camera</option>
              {STUDIO_CAMERAS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}: {item.hint}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-camera-lens`}>
            <span className="block">Lens</span>
            <NativeSelect
              id={`${idPrefix}-camera-lens`}
              value={camera.lens ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onCameraChange({ ...camera, lens: (event.target.value || undefined) as StudioLensId | undefined })
              }
            >
              <option value="">Any lens</option>
              {STUDIO_LENSES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}: {item.hint}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-camera-focal`}>
            <span className="block">Focal length</span>
            <NativeSelect
              id={`${idPrefix}-camera-focal`}
              value={camera.focalLength ? String(camera.focalLength) : ""}
              disabled={disabled}
              onChange={(event) =>
                onCameraChange({
                  ...camera,
                  focalLength: event.target.value ? (Number(event.target.value) as StudioFocalLength) : undefined,
                })
              }
            >
              <option value="">Any framing</option>
              {STUDIO_FOCAL_LENGTHS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}: {item.hint}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-camera-aperture`}>
            <span className="block">Aperture</span>
            <NativeSelect
              id={`${idPrefix}-camera-aperture`}
              value={camera.aperture ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onCameraChange({ ...camera, aperture: (event.target.value || undefined) as StudioApertureId | undefined })
              }
            >
              <option value="">Any focus</option>
              {STUDIO_APERTURES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}: {item.hint}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
      </div>
    </details>
  );
}

/** One-tap words that add lighting, mood, look or finish to a description. */
export function StudioPromptBoosters({
  prompt,
  onPromptChange,
  disabled,
}: {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  disabled?: boolean;
}) {
  const lower = prompt.toLowerCase();
  return (
    <details className="rounded-md border border-border p-3" data-testid="studio-boosters">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Plus className="h-4 w-4 text-primary" aria-hidden="true" />
        Add finishing touches <span className="font-normal text-muted-foreground">(optional)</span>
      </summary>
      <div className="mt-3 space-y-2">
        {STUDIO_PROMPT_BOOSTERS.map((group) => (
          <div key={group.id} className="flex flex-wrap items-center gap-2" role="group" aria-label={group.label}>
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{group.label}</span>
            {group.options.map((option) => {
              const added = lower.includes(option.toLowerCase());
              return (
                <button
                  key={option}
                  type="button"
                  disabled={disabled || added}
                  onClick={() => onPromptChange(addPromptBooster(prompt, option))}
                  className="rounded-full border border-border px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={added ? `${option} (added)` : `Add ${option}`}
                >
                  {option}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </details>
  );
}
