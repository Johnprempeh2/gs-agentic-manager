import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageCoverControls } from "../components/ImageCoverControls";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GENERATED_IMAGE_PROMPT_MIN_LENGTH,
  HIGGSFIELD_API_KEYS_URL,
  imageShapeLabel,
  imageStyleLabel,
  hasStudioCamera,
  studioCameraLabel,
  STUDIO_VARIATION_COUNTS,
  type GeneratedImage,
  type GeneratedImagesResponse,
  type ImageAspectRatio,
  type ImageStylePresetId,
  type StudioCameraSettings,
} from "@greatstone/shared";
import {
  AlertCircle,
  Clapperboard,
  Download,
  ExternalLink,
  ImageIcon,
  Loader2,
  RotateCcw,
  Search,
  Star,
  Trash2,
  Wand2,
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
import { IMAGE_ASPECT_STYLE, IMAGE_IDEA_STARTERS, ImagePromptFields } from "../components/ImagePromptFields";
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
  retrying,
}: {
  image: GeneratedImage;
  makerName: string;
  onOpen: () => void;
  onRetry: () => void;
  onFavourite: (favourite: boolean) => void;
  retrying: boolean;
}) {
  return (
    <figure className="gs-glass-card group flex flex-col overflow-hidden rounded-lg border bg-card" data-testid="generated-image-card">
      <div className="relative w-full overflow-hidden bg-muted" style={{ aspectRatio: ASPECT_STYLE[image.aspectRatio] ?? "1 / 1" }}>
        {image.status === "completed" && image.contentPath ? (
          <button type="button" onClick={onOpen} className="block h-full w-full" aria-label={`Open image: ${image.prompt}`}>
            <img
              src={image.contentPath}
              alt={image.altText}
              loading="lazy"
              className="h-full w-full object-cover transition-transform motion-safe:duration-300 group-hover:scale-105"
            />
          </button>
        ) : null}
        {image.status === "completed" && image.contentPath ? (
          <FavouriteButton
            image={image}
            onToggle={onFavourite}
            className="absolute right-2 top-2 rounded-full bg-background/80 p-1.5 text-foreground shadow-sm hover:bg-background"
          />
        ) : image.status === "pending" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground motion-safe:animate-pulse" role="status">
            <Loader2 className="h-6 w-6 motion-safe:animate-spin" aria-hidden="true" />
            <span className="text-xs">Making your image...</span>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">This image could not be made. Try different words, or try again in a few minutes.</p>
            {image.error ? <p className="line-clamp-2 text-xs text-muted-foreground" title={image.error}>{image.error}</p> : null}
            <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
          </div>
        )}
      </div>
      <figcaption className="space-y-1 p-3">
        <p className="line-clamp-2 text-sm text-foreground" title={image.prompt}>
          {image.prompt}
        </p>
        <p className="text-xs text-muted-foreground">
          {[imageStyleLabel(image.style), imageShapeLabel(image.aspectRatio), studioCameraLabel(image.camera), makerName, relativeTime(image.createdAt)]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <ImageLinks image={image} />
      </figcaption>
    </figure>
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
  const [variations, setVariations] = useState<number>(1);
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
  const trimmed = prompt.trim();
  const canSubmit = configured && trimmed.length >= GENERATED_IMAGE_PROMPT_MIN_LENGTH && !create.isPending;

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
    setOpenId(null);
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  return (
    <div className="w-full max-w-7xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">Image studio</h1>
        <p className="text-sm text-muted-foreground">
          Describe a picture or a short video and GSAM makes it for you. Your agents can make them for their tasks too.
        </p>
      </header>

      <div className="inline-flex rounded-lg bg-muted p-1" role="tablist" aria-label="Studio">
        {(["images", "videos"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={
              tab === value
                ? "rounded-md bg-background px-4 py-1.5 text-sm font-medium text-foreground shadow-sm"
                : "rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            }
            data-testid={`studio-tab-${value}`}
          >
            {value === "images" ? "Images" : "Videos"}
          </button>
        ))}
      </div>

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

      <section
        className="gs-glass-card space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        aria-labelledby="images-composer-title"
        data-tour="images-composer"
      >
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 id="images-composer-title" className="text-sm font-semibold">Make an image</h2>
          {statusQuery.data?.providerLabel ? (
            <span className="ml-auto text-xs text-muted-foreground">Using {statusQuery.data.providerLabel}</span>
          ) : null}
        </div>

        {!configured ? <NotSetUp provider={statusQuery.data?.provider} /> : null}

        <ImagePromptFields
          ref={promptRef}
          idPrefix="image"
          prompt={prompt}
          onPromptChange={setPrompt}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          style={style}
          onStyleChange={setStyle}
          onSubmitShortcut={submit}
          disabled={!configured}
        />

        <StudioPromptBoosters prompt={prompt} onPromptChange={setPrompt} disabled={!configured} />
        <StudioLookPicker
          companyId={companyId}
          idPrefix="image"
          lookId={lookId}
          onPick={(look) => {
            setLookId(look?.id ?? null);
            if (look) {
              setStyle(look.style);
              setCamera(look.camera ?? {});
            }
          }}
          current={{ style, camera }}
          disabled={!configured}
        />
        <StudioLookCompare
          companyId={companyId}
          selected={compareLookIds}
          onChange={setCompareLookIds}
          disabled={!configured || storyboarding}
        />
        <StudioShotList shots={shots} onChange={setShots} disabled={!configured} />
        <StudioCameraFields idPrefix="image" camera={camera} onCameraChange={setCamera} disabled={!configured} />

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
                    : "min-w-10 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                }
              >
                {count}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            More versions give you more to choose from. Each one costs the same as a single image.
          </p>
        </fieldset>

        {organisations && organisations.length > 0 ? (
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
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Usually ready in under a minute. You can leave this page; it keeps going.
          </p>
          <Button onClick={submit} disabled={!canSubmit} data-testid="make-image" data-tour="images-make">
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
        </div>
      </section>

      <div className="space-y-4" data-tour="images-gallery">
        {images.length > 0 || filtering ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative sm:w-80">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                aria-label="Search images"
                placeholder="Search by what the image shows"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-8"
                data-testid="image-search"
              />
            </div>
            {organisations && organisations.length > 0 ? (
              <NativeSelect
                aria-label="Show images for a client"
                value={clientFilter}
                onChange={(event) => setClientFilter(event.target.value)}
                className="sm:w-56"
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
              data-testid="image-favourites-filter"
            >
              <Star className={favouritesOnly ? "h-4 w-4 fill-current" : "h-4 w-4"} aria-hidden="true" />
              Favourites
            </Button>
          </div>
        ) : null}

        {images.length === 0 ? (
          favouritesOnly && !filters.q && !filters.organisationId ? (
            <EmptyState icon={Star} title="No favourites yet" message="Tap the star on an image to keep it here." />
          ) : filtering ? (
            <EmptyState icon={Search} title="No images match" message="Try other words, or show all clients and images." />
          ) : (
            <EmptyState
              icon={ImageIcon}
              title="No images yet"
              message="Images you and your agents make will appear here, ready to download or reuse."
              action="Make your first image"
              onAction={() => {
                promptRef.current?.focus();
                promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          )
        ) : (
          <section aria-label="Your images" className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
                retrying={create.isPending || !configured}
              />
            ))}
          </section>
        )}
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
