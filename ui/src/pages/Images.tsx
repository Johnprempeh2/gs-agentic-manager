import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageCoverControls } from "../components/ImageCoverControls";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GENERATED_IMAGE_PROMPT_MAX_LENGTH,
  GENERATED_IMAGE_PROMPT_MIN_LENGTH,
  HIGGSFIELD_API_KEYS_URL,
  IMAGE_SEED_MAX,
  LOCAL_GPU_LABEL,
  LOCAL_IMAGE_MODELS,
  localImageModel,
  imageShapeLabel,
  imageStyleLabel,
  hasStudioCamera,
  studioCameraLabel,
  STUDIO_VARIATION_COUNTS,
  type CreateGeneratedImage,
  type GeneratedImage,
  type GeneratedImagesResponse,
  type ImageAspectRatio,
  type ImageStylePresetId,
  type StudioCameraSettings,
} from "@greatstone/shared";
import {
  Bookmark,
  Building2,
  Camera,
  Clapperboard,
  Columns2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Film,
  ImageIcon,
  Loader2,
  Palette,
  Plus,
  Proportions,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Trash2,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { imagesApi } from "../api/images";
import { agentsApi } from "../api/agents";
import { organisationsApi } from "../api/organisations";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Link } from "@/lib/router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relativeTime } from "@/lib/utils";
import { IMAGE_ASPECT_STYLE, IMAGE_IDEA_STARTERS, ImageShapePicker, ImageStylePicker } from "../components/ImagePromptFields";
import { STUDIO_GENERATE_CLASS, STUDIO_PROMPT_CLASS, StudioComposer, type StudioComposerChip } from "../components/StudioComposer";
import {
  STUDIO_GALLERY_CLASS,
  STUDIO_MEDIA_CLASS,
  StudioEmptyGallery,
  StudioMediaAction,
  StudioMediaCard,
} from "../components/StudioMediaCard";
import { StudioModeTile } from "../components/StudioModeTile";
import { StudioCameraFields, StudioPromptBoosters } from "../components/StudioCameraFields";
import { StudioLookCompare } from "../components/StudioLookCompare";
import { StudioLookPicker } from "../components/StudioLookPicker";
import { StudioShotList } from "../components/StudioShotList";
import { VideoStudio } from "../components/VideoStudio";

export { IMAGE_IDEA_STARTERS };

const ASPECT_STYLE = IMAGE_ASPECT_STYLE;

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function downloadName(image: GeneratedImage) {
  const slug = image.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${slug || "image"}.png`;
}

function NotSetUp({ provider }: { provider?: string | null }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm" data-testid="images-not-set-up">
      <p className="font-medium text-foreground">Image making is not switched on yet</p>
      <p className="mt-1 text-muted-foreground">
        Ask whoever runs GSAM to connect an image service. Once it is on, you and your agents can make images here.
      </p>
      <details className="mt-3 text-muted-foreground">
        <summary className="cursor-pointer text-xs font-medium">For whoever runs GSAM</summary>
        <p className="mt-2 text-xs">
          Make an API key in the Higgsfield console (no higgsfield.ai plan needed; the API uses its own prepaid balance), then
          set <code>HIGGSFIELD_API_KEY_ID</code> and <code>HIGGSFIELD_API_KEY_SECRET</code> in the server environment and
          restart. {provider ? null : "To try the page without a key, set GSAM_IMAGE_PROVIDER=mock."}
        </p>
        <a
          href={HIGGSFIELD_API_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
          data-testid="images-get-key-link"
        >
          Open the Higgsfield console
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </details>
    </div>
  );
}

/** Star toggle for a finished image; filled when it is a favourite. */
function FavouriteButton({
  image,
  onToggle,
  className,
}: {
  image: GeneratedImage;
  onToggle: (favourite: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={image.favourite}
      aria-label={image.favourite ? "Remove from favourites" : "Add to favourites"}
      title={image.favourite ? "Remove from favourites" : "Add to favourites"}
      onClick={() => onToggle(!image.favourite)}
      className={className}
      data-testid="image-favourite"
    >
      <Star className={image.favourite ? "h-4 w-4 fill-current text-primary" : "h-4 w-4"} aria-hidden="true" />
    </button>
  );
}

function ImageCard({
  image,
  makerName,
  onOpen,
  onRetry,
  onFavourite,
  onReuse,
  onAnimate,
  retrying,
}: {
  image: GeneratedImage;
  makerName: string;
  onOpen: () => void;
  onRetry: () => void;
  onFavourite: (favourite: boolean) => void;
  onReuse: () => void;
  onAnimate: () => void;
  retrying: boolean;
}) {
  const finished = image.status === "completed" && !!image.contentPath;
  return (
    <StudioMediaCard
      data-testid="generated-image-card"
      aspectRatio={ASPECT_STYLE[image.aspectRatio] ?? "1 / 1"}
      status={finished ? "completed" : image.status === "pending" ? "pending" : "failed"}
      pendingLabel="Making your image..."
      media={
        <button type="button" onClick={onOpen} className="block h-full w-full outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-inset focus-visible:ring-ring" aria-label={`Open image: ${image.prompt}`}>
          <img src={image.contentPath ?? undefined} alt={image.altText} loading="lazy" className={STUDIO_MEDIA_CLASS} />
        </button>
      }
      failure={{
        message: "This image could not be made. Try different words, or try again in a few minutes.",
        detail: image.error,
        onRetry,
        retrying,
      }}
      badges={
        image.favourite ? (
          <span className="grid size-8 place-items-center rounded-full bg-background/80 text-primary shadow-sm" aria-hidden="true">
            <Star className="h-4 w-4 fill-current" />
          </span>
        ) : null
      }
      actions={
        <>
          <StudioMediaAction
            icon={Star}
            label={image.favourite ? "Remove from favourites" : "Add to favourites"}
            pressed={image.favourite}
            onClick={() => onFavourite(!image.favourite)}
            iconClassName={image.favourite ? "fill-current text-primary" : undefined}
            data-testid="image-favourite"
          />
          <StudioMediaAction icon={RotateCcw} label="Make another like this" onClick={onReuse} data-testid="image-card-reuse" />
          <StudioMediaAction icon={Clapperboard} label="Animate this image" onClick={onAnimate} data-testid="image-card-animate" />
          <StudioMediaAction icon={Download} label="Download" href={image.contentPath ?? undefined} download={downloadName(image)} data-testid="image-card-download" />
        </>
      }
      caption={
        <>
          <p className="line-clamp-2 text-sm text-foreground" title={image.prompt}>
            {image.prompt}
          </p>
          <p className="text-xs text-muted-foreground">
            {[imageStyleLabel(image.style), imageShapeLabel(image.aspectRatio), studioCameraLabel(image.camera), makerName, relativeTime(image.createdAt)]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <ImageLinks image={image} />
        </>
      }
    />
  );
}

function taskHref(issue: { id: string; identifier: string | null }) {
  return `/issues/${issue.identifier ?? issue.id}`;
}

/** Where an image belongs: the task it was made for and the client. */
function ImageLinks({ image }: { image: GeneratedImage }) {
  if (!image.issue && !image.organisation) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {image.organisation ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{image.organisation.name}</span>
      ) : null}
      {image.issue ? (
        <Link
          to={taskHref(image.issue)}
          className="max-w-full truncate rounded-full border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent"
          title={image.issue.title}
        >
          {image.issue.identifier ? `${image.issue.identifier} ` : ""}
          {image.issue.title}
        </Link>
      ) : null}
    </div>
  );
}

export function Images() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const toast = useOptionalToastActions();
  const pushToast = toast?.pushToast ?? (() => null);
  const queryClient = useQueryClient();
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [style, setStyle] = useState<ImageStylePresetId | null>(null);
  const [camera, setCamera] = useState<StudioCameraSettings>({});
  const [lookId, setLookId] = useState<string | null>(null);
  const [lookName, setLookName] = useState<string | null>(null);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [variations, setVariations] = useState<number>(1);
  /** "" is the server's default; "cloud" its paid service; "local:<model>" this PC. */
  const [engine, setEngine] = useState("");
  const [seed, setSeed] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [compareLookIds, setCompareLookIds] = useState<string[]>([]);
  const [shots, setShots] = useState<string[]>([]);
  const [organisationId, setOrganisationId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [tab, setTab] = useState<"images" | "videos">("images");
  const [animateImage, setAnimateImage] = useState<GeneratedImage | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Images" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const companyId = selectedCompanyId ?? "";
  const filters = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      organisationId: clientFilter || undefined,
      ...(favouritesOnly ? { favourite: true } : {}),
    }),
    [debouncedSearch, clientFilter, favouritesOnly],
  );
  const filtering = !!filters.q || !!filters.organisationId || favouritesOnly;
  const statusQuery = useQuery({
    queryKey: queryKeys.images.status(companyId),
    queryFn: () => imagesApi.status(companyId),
    enabled: !!selectedCompanyId,
  });
  const listQuery = useQuery({
    queryKey: queryKeys.images.list(companyId, filters),
    queryFn: () => imagesApi.list(companyId, { limit: 120, ...filters }),
    placeholderData: (previous) => previous,
    enabled: !!selectedCompanyId,
    // Keep checking while any image is still being made.
    refetchInterval: (query) =>
      query.state.data?.images.some((image) => image.status === "pending") ? 3_000 : false,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!selectedCompanyId,
  });
  const { data: organisations } = useQuery({
    queryKey: queryKeys.organisations.list(companyId, {}),
    queryFn: () => organisationsApi.list(companyId),
    enabled: !!selectedCompanyId,
  });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const currentUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const agentNames = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.name])), [agents]);
  const makerName = useCallback(
    (image: GeneratedImage) =>
      image.createdByAgentId
        ? agentNames.get(image.createdByAgentId) ?? "An agent"
        : image.createdByUserId && image.createdByUserId === currentUserId
          ? "You"
          : "A teammate",
    [agentNames, currentUserId],
  );

  const create = useMutation({
    mutationFn: async (input: {
      prompt: string;
      aspectRatio: ImageAspectRatio;
      style?: ImageStylePresetId | null;
      camera?: StudioCameraSettings | null;
      lookId?: string | null;
      organisationId?: string | null;
      issueId?: string | null;
      count?: number;
      lookIds?: string[];
      shots?: string[];
      provider?: CreateGeneratedImage["provider"];
      model?: string;
      seed?: number;
      negativePrompt?: string;
    }) => {
      const { count = 1, lookIds, shots: storyboard, ...body } = input;
      if (storyboard && storyboard.length >= 2) {
        return (await imagesApi.createVariations(companyId, { ...body, shots: storyboard })).images;
      }
      // Several versions go in one request, so they all start or none do.
      if (lookIds && lookIds.length >= 2) {
        return (await imagesApi.createVariations(companyId, { ...body, lookId: null, lookIds })).images;
      }
      if (count > 1) return (await imagesApi.createVariations(companyId, { ...body, count })).images;
      return [await imagesApi.create(companyId, body)];
    },
    onSuccess: (made) => {
      // Show the new images straight away in every gallery view; the refetch settles filters.
      queryClient.setQueriesData<GeneratedImagesResponse>({ queryKey: queryKeys.images.list(companyId) }, (current) =>
        current ? { ...current, images: [...[...made].reverse(), ...current.images], total: current.total + made.length } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.list(companyId) });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.list(companyId) });
      pushToast({ title: errorMessage(error), tone: "error" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => imagesApi.remove(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      setOpenId(null);
      pushToast({ title: "Image deleted", tone: "success", ttlMs: 2500 });
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.list(companyId) });
    },
    onError: (error) => pushToast({ title: errorMessage(error), tone: "error" }),
  });

  const favourite = useMutation({
    mutationFn: ({ id, favourite: value }: { id: string; favourite: boolean }) => imagesApi.setFavourite(id, { favourite: value }),
    onMutate: async ({ id, favourite: value }) => {
      // Fill the star straight away (after any refetch in flight, which would undo it);
      // the refetch afterwards settles the favourites filter.
      await queryClient.cancelQueries({ queryKey: queryKeys.images.list(companyId) });
      queryClient.setQueriesData<GeneratedImagesResponse>({ queryKey: queryKeys.images.list(companyId) }, (current) =>
        current
          ? { ...current, images: current.images.map((image) => (image.id === id ? { ...image, favourite: value } : image)) }
          : current,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.images.list(companyId) }),
    onError: (error) => pushToast({ title: errorMessage(error), tone: "error" }),
  });

  const configured = statusQuery.data?.configured === true;
  // The model picker: the paid service when one is set up, and this PC's models only while ComfyUI answers.
  const cloudProvider = statusQuery.data?.provider && statusQuery.data.provider !== "local" ? statusQuery.data : null;
  const engineChoices = [
    ...(cloudProvider
      ? [{ key: "cloud", label: cloudProvider.providerLabel ?? "Image service", hint: `Uses ${cloudProvider.providerLabel ?? "its"} credits` }]
      : []),
    ...LOCAL_IMAGE_MODELS.filter((model) => statusQuery.data?.local?.imageModels.includes(model.id)).map((model) => ({
      key: `local:${model.id}`,
      label: `${model.label}, ${LOCAL_GPU_LABEL}`,
      hint: `${model.hint}. No cost.`,
    })),
  ];
  const pickedEngine = engineChoices.find((choice) => choice.key === engine) ?? engineChoices[0] ?? null;
  const localModel = pickedEngine?.key.startsWith("local:") ? localImageModel(pickedEngine.key.slice("local:".length)) : null;
  const seedNumber = seed.trim() === "" ? undefined : Number(seed);
  const seedValid = seedNumber === undefined || (Number.isInteger(seedNumber) && seedNumber >= 0 && seedNumber <= IMAGE_SEED_MAX);
  const engineRequest = localModel
    ? {
        provider: "local" as const,
        model: localModel.id,
        ...(seedNumber !== undefined && seedValid ? { seed: seedNumber } : {}),
        ...(localModel.negativePrompt && negativePrompt.trim() ? { negativePrompt: negativePrompt.trim() } : {}),
      }
    : engine === "cloud" && cloudProvider?.provider
      ? { provider: cloudProvider.provider }
      : {};
  const trimmed = prompt.trim();
  const canSubmit = configured && seedValid && trimmed.length >= GENERATED_IMAGE_PROMPT_MIN_LENGTH && !create.isPending;

  const shotLines = shots.map((shot) => shot.trim()).filter(Boolean);
  const storyboarding = shotLines.length >= 2;
  const comparing = !storyboarding && compareLookIds.length >= 2;
  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        prompt: trimmed,
        aspectRatio,
        style,
        ...(hasStudioCamera(camera) ? { camera } : {}),
        ...(lookId ? { lookId } : {}),
        organisationId: organisationId || null,
        count: variations,
        ...(comparing ? { lookIds: compareLookIds } : {}),
        ...(storyboarding ? { shots: shotLines } : {}),
        ...engineRequest,
      },
      {
        onSuccess: () => {
          setPrompt("");
          setShots([]);
        },
      },
    );
  };

  const reuse = (image: GeneratedImage) => {
    setPrompt(image.prompt);
    setAspectRatio(image.aspectRatio);
    setStyle(image.style);
    setCamera(image.camera ?? {});
    // The description already carries the look's words, so do not add them twice.
    setLookId(null);
    setOrganisationId(image.organisation?.id ?? "");
    setLookName(null);
    setOpenId(null);
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={ImageIcon} message="Select an organisation to make images." />;
  }
  if (statusQuery.isLoading || listQuery.isLoading) return <PageSkeleton />;
  if (listQuery.error) {
    return <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} retrying={listQuery.isFetching} />;
  }

  const images = listQuery.data?.images ?? [];
  const opened = images.find((image) => image.id === openId) ?? null;
  const toDelete = images.find((image) => image.id === confirmDeleteId) ?? null;

  const focusPrompt = () => {
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };
  const pickStarter = (starter: (typeof IMAGE_IDEA_STARTERS)[number]) => {
    setPrompt(starter.prompt);
    setAspectRatio(starter.aspectRatio);
    promptRef.current?.focus();
  };
  const openMode = (mode: "images" | "videos", chip: string | null = null) => {
    setTab(mode);
    setOpenChip(chip);
    if (mode === "images") requestAnimationFrame(focusPrompt);
  };
  const starterChips = IMAGE_IDEA_STARTERS.map((starter) => ({ label: starter.label, onPick: () => pickStarter(starter) }));
  const pickedClient = organisations?.find((organisation) => organisation.id === organisationId)?.name ?? null;

  const chips: StudioComposerChip[] = [
    ...(engineChoices.some((choice) => choice.key.startsWith("local:"))
      ? [
          {
            id: "model",
            icon: Cpu,
            label: "Model",
            value: pickedEngine?.label ?? null,
            panel: (
              <div className="space-y-3">
                <fieldset className="space-y-2" disabled={!configured}>
                  <legend className="text-sm font-medium">Which model makes it?</legend>
                  <div className="flex flex-col gap-2" role="radiogroup" aria-label="Model" data-testid="image-model">
                    {engineChoices.map((choice) => (
                      <button
                        key={choice.key}
                        type="button"
                        role="radio"
                        aria-checked={pickedEngine?.key === choice.key}
                        onClick={() => setEngine(choice.key)}
                        className={
                          pickedEngine?.key === choice.key
                            ? "rounded-md border border-primary bg-primary/10 px-3 py-2 text-left text-sm ring-1 ring-primary"
                            : "rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/40"
                        }
                      >
                        <span className="block font-medium">{choice.label}</span>
                        <span className="block text-xs text-muted-foreground">{choice.hint}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
                {localModel ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm font-medium" htmlFor="image-seed">
                      <span className="block">
                        Seed <span className="font-normal text-muted-foreground">(optional)</span>
                      </span>
                      <Input
                        id="image-seed"
                        inputMode="numeric"
                        value={seed}
                        onChange={(event) => setSeed(event.target.value.replace(/[^0-9]/g, ""))}
                        placeholder="Random"
                        aria-invalid={!seedValid}
                        aria-describedby="image-seed-hint"
                        data-testid="image-seed"
                      />
                      <span id="image-seed-hint" className="block text-xs font-normal text-muted-foreground">
                        {seedValid ? "The same seed and words make the same picture again." : "Use a whole number up to 4294967295."}
                      </span>
                    </label>
                    {localModel.negativePrompt ? (
                      <label className="space-y-1 text-sm font-medium" htmlFor="image-negative">
                        <span className="block">
                          Leave out <span className="font-normal text-muted-foreground">(optional)</span>
                        </span>
                        <Input
                          id="image-negative"
                          value={negativePrompt}
                          onChange={(event) => setNegativePrompt(event.target.value)}
                          placeholder="For example: text, blur, extra fingers"
                          maxLength={1000}
                          data-testid="image-negative"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
    {
      id: "shape",
      icon: Proportions,
      label: "Shape",
      value: imageShapeLabel(aspectRatio),
      panel: <ImageShapePicker aspectRatio={aspectRatio} onAspectRatioChange={setAspectRatio} disabled={!configured} />,
    },
    {
      id: "style",
      icon: Palette,
      label: "Style",
      value: imageStyleLabel(style),
      panel: <ImageStylePicker style={style} onStyleChange={setStyle} onAspectRatioChange={setAspectRatio} disabled={!configured} />,
    },
    {
      id: "look",
      icon: Bookmark,
      label: "House look",
      value: lookId ? lookName : null,
      panel: (
        <StudioLookPicker
          companyId={companyId}
          idPrefix="image"
          lookId={lookId}
          onPick={(look) => {
            setLookId(look?.id ?? null);
            setLookName(look?.name ?? null);
            if (look) {
              setStyle(look.style);
              setCamera(look.camera ?? {});
            }
          }}
          current={{ style, camera }}
          disabled={!configured}
        />
      ),
    },
    {
      id: "camera",
      icon: Camera,
      label: "Camera",
      value: studioCameraLabel(camera),
      panel: <StudioCameraFields idPrefix="image" camera={camera} onCameraChange={setCamera} disabled={!configured} />,
    },
    {
      id: "touches",
      icon: Plus,
      label: "Finishing touches",
      panel: <StudioPromptBoosters prompt={prompt} onPromptChange={setPrompt} disabled={!configured} />,
    },
    {
      id: "storyboard",
      icon: Clapperboard,
      label: "Storyboard",
      value: shotLines.length > 0 ? `${shotLines.length} shots` : null,
      panel: <StudioShotList shots={shots} onChange={setShots} disabled={!configured} />,
    },
    {
      id: "compare",
      icon: Columns2,
      label: "Compare looks",
      value: compareLookIds.length >= 2 ? `${compareLookIds.length} looks` : null,
      panel: (
        <StudioLookCompare
          companyId={companyId}
          selected={compareLookIds}
          onChange={setCompareLookIds}
          disabled={!configured || storyboarding}
        />
      ),
    },
    {
      id: "versions",
      icon: Copy,
      label: "Versions",
      value: variations > 1 ? `${variations} versions` : "1 version",
      panel: (
        <fieldset className="space-y-2" disabled={!configured || comparing || storyboarding}>
          <legend className="text-sm font-medium">How many versions?</legend>
          <div className="flex gap-2" role="radiogroup" aria-label="How many versions" data-testid="image-variations">
            {STUDIO_VARIATION_COUNTS.map((count) => (
              <button
                key={count}
                type="button"
                role="radio"
                aria-checked={variations === count}
                onClick={() => setVariations(count)}
                className={
                  variations === count
                    ? "min-w-10 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm ring-1 ring-primary"
                    : "min-w-10 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/40 disabled:cursor-not-allowed disabled:text-subtle-foreground"
                }
              >
                {count}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {localModel
              ? "More versions give you more to choose from. They are made on this PC one after another, at no cost."
              : "More versions give you more to choose from. Each one costs the same as a single image."}
          </p>
        </fieldset>
      ),
    },
    ...(organisations && organisations.length > 0
      ? [
          {
            id: "client",
            icon: Building2,
            label: "Client",
            value: pickedClient,
            panel: (
              <div className="space-y-2">
                <label htmlFor="image-client" className="text-sm font-medium">
                  Who is it for? <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <NativeSelect
                  id="image-client"
                  value={organisationId}
                  onChange={(event) => setOrganisationId(event.target.value)}
                  disabled={!configured}
                  className="sm:w-72"
                  data-testid="image-client"
                >
                  <option value="">No particular client</option>
                  {organisations.map((organisation) => (
                    <option key={organisation.id} value={organisation.id}>
                      {organisation.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ),
          },
        ]
      : []),
    {
      id: "ideas",
      icon: Sparkles,
      label: "Ideas",
      panel: (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Ready-made ideas">
          {IMAGE_IDEA_STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              disabled={!configured}
              onClick={() => pickStarter(starter)}
              className="rounded-full border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:text-subtle-foreground"
            >
              {starter.label}
            </button>
          ))}
        </div>
      ),
    },
  ];

  const modes: Array<{ id: string; icon: LucideIcon; title: string; description: string; badge?: string; onClick: () => void; selected?: boolean }> = [
    { id: "images", icon: ImageIcon, title: "Image", description: "Pictures from a few words", selected: tab === "images", onClick: () => openMode("images") },
    { id: "videos", icon: Film, title: "Video", description: "Short clips, or bring an image to life", selected: tab === "videos", onClick: () => openMode("videos") },
    { id: "storyboard", icon: Clapperboard, title: "Storyboard", description: "Two to four shots that belong together", badge: "New", onClick: () => openMode("images", "storyboard") },
    { id: "compare", icon: Columns2, title: "Compare looks", description: "The same picture in each house look", badge: "New", onClick: () => openMode("images", "compare") },
    { id: "looks", icon: Bookmark, title: "House looks", description: "Your saved client styles, one pick away", onClick: () => openMode("images", "look") },
    { id: "camera", icon: Camera, title: "Camera", description: "Shoot it like a film: lens and focus", onClick: () => openMode("images", "camera") },
  ];

  return (
    <div className="w-full max-w-7xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-extrabold uppercase tracking-tight">{tab === "videos" ? "Video studio" : "Image studio"}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Describe a picture or a short video and GSAM makes it for you. Your agents can make them for their tasks too.
        </p>
      </header>

      <nav aria-label="Studio modes" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {modes.map((mode) => (
          <StudioModeTile
            key={mode.id}
            icon={mode.icon}
            title={mode.title}
            description={mode.description}
            badge={mode.badge}
            selected={mode.selected}
            onClick={mode.onClick}
            data-testid={mode.id === "images" || mode.id === "videos" ? `studio-tab-${mode.id}` : `studio-mode-${mode.id}`}
          />
        ))}
      </nav>

      {tab === "videos" ? (
        <VideoStudio
          companyId={companyId}
          sourceImage={animateImage}
          onClearSourceImage={() => setAnimateImage(null)}
          onError={(message) => pushToast({ title: message, tone: "error" })}
          onDeleted={() => pushToast({ title: "Video deleted", tone: "success", ttlMs: 2500 })}
        />
      ) : (
        <>
          {!configured ? <NotSetUp provider={statusQuery.data?.provider} /> : null}
          <div className="flex flex-col gap-6">
            <StudioComposer
              title="Make an image"
              aside={
                localModel
                  ? `Using ${LOCAL_GPU_LABEL}, no cost`
                  : pickedEngine
                    ? `Using ${pickedEngine.label}`
                    : statusQuery.data?.providerLabel
                      ? `Using ${statusQuery.data.providerLabel}`
                      : null
              }
              chips={chips}
              openChip={openChip}
              onOpenChipChange={setOpenChip}
              data-tour="images-composer"
              footnote="Usually ready in under a minute. You can leave this page; it keeps going."
              action={
                <Button onClick={submit} disabled={!canSubmit} className={STUDIO_GENERATE_CLASS} data-testid="make-image" data-tour="images-make">
                  {create.isPending ? (
                    <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                  ) : (
                    <Wand2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  {storyboarding
                    ? `Make storyboard (${shotLines.length} shots)`
                    : comparing
                      ? `Compare ${compareLookIds.length} looks`
                      : variations > 1
                        ? `Make ${variations} images`
                        : "Make image"}
                </Button>
              }
            >
              <label htmlFor="image-prompt" className="sr-only">
                What should the image show?
              </label>
              <Textarea
                id="image-prompt"
                ref={promptRef}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Describe the image you want. For example: a watercolour of a busy London street market at dusk, soft warm light, no text"
                maxLength={GENERATED_IMAGE_PROMPT_MAX_LENGTH}
                rows={2}
                disabled={!configured}
                className={STUDIO_PROMPT_CLASS}
                data-testid="image-prompt"
              />
            </StudioComposer>

            <div className="space-y-4" data-tour="images-gallery">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <h2 className="text-lg font-bold uppercase tracking-tight">
                  {favouritesOnly ? "Favourites" : "Your images"}
                  {images.length > 0 ? <span className="ml-2 text-sm font-medium text-muted-foreground">{images.length}</span> : null}
                </h2>
                {images.length > 0 || filtering ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative sm:w-72">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                      <Input
                        aria-label="Search images"
                        placeholder="Search by what the image shows"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        className="rounded-full pl-8"
                        data-testid="image-search"
                      />
                    </div>
                    {organisations && organisations.length > 0 ? (
                      <NativeSelect
                        aria-label="Show images for a client"
                        value={clientFilter}
                        onChange={(event) => setClientFilter(event.target.value)}
                        className="sm:w-48"
                      >
                        <option value="">All clients</option>
                        {organisations.map((organisation) => (
                          <option key={organisation.id} value={organisation.id}>
                            {organisation.name}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : null}
                    <Button
                      variant={favouritesOnly ? "default" : "outline"}
                      aria-pressed={favouritesOnly}
                      onClick={() => setFavouritesOnly((value) => !value)}
                      className="rounded-full"
                      data-testid="image-favourites-filter"
                    >
                      <Star className={favouritesOnly ? "h-4 w-4 fill-current" : "h-4 w-4"} aria-hidden="true" />
                      Favourites
                    </Button>
                  </div>
                ) : null}
              </div>

              {images.length === 0 ? (
                favouritesOnly && !filters.q && !filters.organisationId ? (
                  <StudioEmptyGallery icon={Star} title="No favourites yet" message="Tap the star on an image to keep it here." />
                ) : filtering ? (
                  <StudioEmptyGallery icon={Search} title="No images match" message="Try other words, or show all clients and images." />
                ) : (
                  <StudioEmptyGallery
                    icon={ImageIcon}
                    title="No images yet"
                    message="Images you and your agents make will appear here, ready to download or reuse. Start with an idea:"
                    suggestions={starterChips}
                    disabled={!configured}
                  />
                )
              ) : (
                <section aria-label="Your images" className={STUDIO_GALLERY_CLASS}>
                  {images.map((image) => (
                    <ImageCard
                      key={image.id}
                      image={image}
                      makerName={makerName(image)}
                      onOpen={() => setOpenId(image.id)}
                      onRetry={() =>
                        create.mutate({
                          prompt: image.prompt,
                          aspectRatio: image.aspectRatio,
                          style: image.style,
                          ...(image.camera ? { camera: image.camera } : {}),
                          organisationId: image.organisation?.id ?? null,
                          issueId: image.issue?.id ?? null,
                        })
                      }
                      onFavourite={(value) => favourite.mutate({ id: image.id, favourite: value })}
                      onReuse={() => reuse(image)}
                      onAnimate={() => {
                        setAnimateImage(image);
                        setTab("videos");
                      }}
                      retrying={create.isPending || !configured}
                    />
                  ))}
                </section>
              )}
            </div>
          </div>
        </>
      )}

      <Dialog open={!!opened} onOpenChange={(open) => (!open ? setOpenId(null) : undefined)}>
        <DialogContent className="max-w-4xl">
          {opened ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  Image
                  {opened.status === "completed" ? (
                    <FavouriteButton
                      image={opened}
                      onToggle={(value) => favourite.mutate({ id: opened.id, favourite: value })}
                      className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    />
                  ) : null}
                </DialogTitle>
                <DialogDescription className="whitespace-pre-wrap">{opened.prompt}</DialogDescription>
              </DialogHeader>
              {opened.contentPath ? (
                <img src={opened.contentPath} alt={opened.altText} className="max-h-(--sz-70vh) w-full rounded-md object-contain" />
              ) : null}
              <p className="text-xs text-muted-foreground">
                {[imageStyleLabel(opened.style), imageShapeLabel(opened.aspectRatio), studioCameraLabel(opened.camera), `Made by ${makerName(opened)}`, relativeTime(opened.createdAt)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <ImageLinks image={opened} />
              <ImageCoverControls image={opened} />
              <DialogFooter className="gap-2 sm:justify-between">
                <Button variant="ghost" onClick={() => setConfirmDeleteId(opened.id)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete
                </Button>
                <div className="flex flex-wrap gap-2">
                  {opened.contentPath ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setAnimateImage(opened);
                        setOpenId(null);
                        setTab("videos");
                      }}
                      data-testid="animate-image"
                    >
                      <Clapperboard className="h-4 w-4" aria-hidden="true" />
                      Animate
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => reuse(opened)}>
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    Make another like this
                  </Button>
                  {opened.contentPath ? (
                    <Button asChild>
                      <a href={opened.contentPath} download={downloadName(opened)}>
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download
                      </a>
                    </Button>
                  ) : null}
                </div>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!toDelete} onOpenChange={(open) => (!open ? setConfirmDeleteId(null) : undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this image?</DialogTitle>
            <DialogDescription>
              It will be removed from Images for everyone. Copies already attached to tasks stay where they are.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => toDelete && remove.mutate(toDelete.id)}
              disabled={remove.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
