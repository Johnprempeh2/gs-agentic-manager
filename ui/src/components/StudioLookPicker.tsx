import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  hasStudioCamera,
  imageStyleLabel,
  STUDIO_LOOK_NAME_MAX_LENGTH,
  STUDIO_LOOK_WORDS_MAX_LENGTH,
  studioCameraLabel,
  type ImageStylePresetId,
  type StudioCameraSettings,
  type StudioLook,
} from "@greatstone/shared";
import { Bookmark, Trash2 } from "lucide-react";
import { studioLooksApi } from "../api/studioLooks";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function studioLookSummary(look: Pick<StudioLook, "style" | "camera" | "words">): string {
  return [imageStyleLabel(look.style), studioCameraLabel(look.camera), look.words]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

interface StudioLookPickerProps {
  companyId: string;
  idPrefix: string;
  lookId: string | null;
  /** Called with the picked look (its style and camera fill the form), or null for none. */
  onPick: (look: StudioLook | null) => void;
  /** What "Save as a house look" keeps. Videos have no style, so they pass none. */
  current: { style?: ImageStylePresetId | null; camera: StudioCameraSettings };
  disabled?: boolean;
}

/**
 * House looks: the company's saved style, camera and words under one name, so
 * every image or clip for a client comes out the same. Picking one fills the
 * form; its words are added by the server when the request is made.
 */
export function StudioLookPicker({ companyId, idPrefix, lookId, onPick, current, disabled }: StudioLookPickerProps) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [words, setWords] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const looksQuery = useQuery({
    queryKey: queryKeys.studioLooks.list(companyId),
    queryFn: () => studioLooksApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const looks = looksQuery.data?.looks ?? [];
  const picked = looks.find((look) => look.id === lookId) ?? null;

  const save = useMutation({
    mutationFn: () =>
      studioLooksApi.create(companyId, {
        name: name.trim(),
        ...(current.style !== undefined ? { style: current.style } : {}),
        camera: hasStudioCamera(current.camera) ? current.camera : null,
        words: words.trim() || null,
      }),
    onSuccess: (look) => {
      setSaving(false);
      setName("");
      setWords("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.studioLooks.list(companyId) });
      onPick(look);
    },
    onError: (failure) => setError(errorMessage(failure)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => studioLooksApi.remove(id),
    onSuccess: () => {
      setConfirmDelete(false);
      onPick(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.studioLooks.list(companyId) });
    },
    onError: (failure) => setError(errorMessage(failure)),
  });

  return (
    <div className="space-y-2" data-testid={`${idPrefix}-house-look`}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1 text-sm font-medium" htmlFor={`${idPrefix}-house-look`}>
          <span className="flex items-center gap-2">
            <Bookmark className="h-4 w-4 text-primary" aria-hidden="true" />
            House look <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <NativeSelect
            id={`${idPrefix}-house-look`}
            value={lookId ?? ""}
            disabled={disabled || looksQuery.isLoading}
            onChange={(event) => {
              setConfirmDelete(false);
              onPick(looks.find((look) => look.id === event.target.value) ?? null);
            }}
          >
            <option value="">{looks.length ? "No house look" : "No house looks saved yet"}</option>
            {looks.map((look) => (
              <option key={look.id} value={look.id}>
                {look.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        {picked ? (
          confirmDelete ? (
            <>
              <Button size="sm" variant="destructive" onClick={() => remove.mutate(picked.id)} disabled={remove.isPending}>
                Delete "{picked.name}"
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete the ${picked.name} look`} disabled={disabled}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          )
        ) : null}
        {!saving ? (
          <Button size="sm" variant="outline" onClick={() => setSaving(true)} disabled={disabled}>
            Save as a house look
          </Button>
        ) : null}
      </div>
      {picked ? (
        <p className="text-xs text-muted-foreground">
          {picked.description ? `${picked.description}. ` : ""}
          {studioLookSummary(picked) || "No settings saved in this look."}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Save the settings you use for a client, and anyone can make matching pictures with one pick.</p>
      )}
      {saving ? (
        <form
          className="grid gap-2 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-look-name`}>
            <span className="block">Name</span>
            <Input
              id={`${idPrefix}-look-name`}
              value={name}
              maxLength={STUDIO_LOOK_NAME_MAX_LENGTH}
              placeholder="For example Acme product shots"
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          <label className="space-y-1 text-xs font-medium" htmlFor={`${idPrefix}-look-words`}>
            <span className="block">Words to add every time (optional)</span>
            <Input
              id={`${idPrefix}-look-words`}
              value={words}
              maxLength={STUDIO_LOOK_WORDS_MAX_LENGTH}
              placeholder="For example navy and gold colours, soft morning light"
              onChange={(event) => setWords(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Keeps {[imageStyleLabel(current.style ?? null), studioCameraLabel(current.camera)].filter(Boolean).join(" and ") || "the words above"}.
          </p>
          <div className="flex justify-between gap-2 sm:col-span-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setSaving(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim() || save.isPending}>
              Save look
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
