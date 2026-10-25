import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MessageSquarePlus, Palette, RefreshCw } from "lucide-react";
import type {
  WebsiteProperty,
  WebsiteSite,
  WebsiteSiteStyle,
  WebsiteStyleColour,
  WebsiteStyleColourRole,
  WebsiteStyleComponent,
  WebsiteStyleContrast,
  WebsiteStyleContrastRating,
  WebsiteStyleTextStyle,
  WebsiteStyleToken,
  WebsiteStyleTokenKind,
} from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { useDialogActions } from "../../context/DialogContext";
import { queryKeys } from "../../lib/queryKeys";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CopyText } from "../CopyText";
import { ErrorState } from "../ErrorState";
import { useWebsiteSite } from "./WebsiteSiteConnection";

// The Website Style tab (GRE-2520, John 25 Oct 2026): the site's colours, fonts
// and building blocks at a glance. Everything comes from one read
// (`/website/sites/:siteId/style`): the live stylesheet with the release theme
// on top, as a visitor gets it. Read-only; every value copies in one click and
// Ask an agent opens a task with the token attached. The site's own colours
// and fonts draw the samples, so they show as on the site in either GSAM theme.

const ROLE_LABELS: Record<WebsiteStyleColourRole, string> = {
  background: "Backgrounds",
  text: "Text",
  accent: "Accents",
  border: "Borders",
  status: "Status",
  other: "Other colours",
};

const TOKEN_LABELS: Record<WebsiteStyleTokenKind, string> = {
  radius: "Corner radius",
  spacing: "Spacing",
  size: "Sizes",
  motion: "Motion",
  other: "Other tokens",
};

const RATING_CLASS: Record<WebsiteStyleContrastRating, string> = {
  AAA: "bg-status-success-soft text-status-success-foreground",
  AA: "bg-status-success-soft text-status-success-foreground",
  "AA large": "bg-status-warning-soft text-status-warning-foreground",
  Fail: "bg-status-danger-soft text-status-danger-foreground",
};

const CONTRAST_LIMIT = 12;

/** The page the samples sit on: the site's own background, text colour and body font. */
export function siteCanvas(style: WebsiteSiteStyle): CSSProperties {
  const page = style.surfaces.find((surface) => surface.selector === "body")?.background;
  const background = page ?? style.colours.find((colour) => colour.role === "background")?.value;
  const body = style.textStyles.find((text) => text.selector === "body");
  return {
    background: background ?? undefined,
    color: body?.color ?? style.colours.find((colour) => colour.role === "text")?.value ?? undefined,
    fontFamily: body?.fontFamily ?? style.fonts[0]?.stack ?? undefined,
  };
}

// Only what draws the block itself: no layout, position or motion, and no files the
// site links by a relative address (they would load from GSAM, not the site).
const BLOCK_PROPERTIES = new Set([
  "color", "background", "background-color", "background-image", "border", "border-color", "border-style", "border-width",
  "border-top", "border-bottom", "border-left", "border-right", "border-radius", "padding", "padding-top", "padding-bottom",
  "padding-left", "padding-right", "padding-inline", "padding-block", "font-family", "font-size", "font-weight", "font-style",
  "line-height", "letter-spacing", "text-transform", "text-decoration", "text-decoration-color", "text-underline-offset",
  "box-shadow", "gap", "outline", "opacity", "backdrop-filter", "min-height",
]);

/** A block's own declarations as React inline style, keeping only what draws it. */
export function blockStyle(declarations: Record<string, string>): CSSProperties {
  const style: Record<string, string> = {};
  for (const [prop, value] of Object.entries(declarations)) {
    if (!BLOCK_PROPERTIES.has(prop) || /url\(|var\(|expression/i.test(value)) continue;
    style[prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
  }
  return style as CSSProperties;
}

/** The task Ask an agent opens: what to change, with the token and where it is used. */
export function styleTaskDefaults(siteName: string, subject: { label: string; name: string; token: string | null; value: string; usedIn?: string[] }) {
  const lines = [
    `Style change on ${siteName}: ${subject.label}`,
    "",
    `- Token: \`${subject.name}\`${subject.token ? ` (release theme token \`${subject.token}\`)` : ""}`,
    `- Value now: \`${subject.value}\``,
    ...(subject.usedIn?.length ? [`- Used in: ${subject.usedIn.map((s) => `\`${s}\``).join(", ")}`] : []),
    "",
    "Use the site's own tokens (the website_style_get tool lists them). What should change:",
    "",
  ];
  return { title: `Style: ${subject.label} (${subject.name})`, description: lines.join("\n") };
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`website-style-${id}`} className="space-y-3" data-testid={`website-style-${id}`}>
      <div>
        <h2 id={`website-style-${id}`} className="text-base font-semibold">{title}</h2>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function AskButton({ onAsk, label }: { onAsk: () => void; label: string }) {
  return (
    <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onAsk} aria-label={`Ask an agent about ${label}`}>
      <MessageSquarePlus />
      Ask an agent
    </Button>
  );
}

/** A value that copies on click. A long one ends in an ellipsis; the whole value shows on hover and copies. */
function CopyValue({ text, label }: { text: string; label: string }) {
  return (
    <CopyText
      text={text}
      ariaLabel={`Copy ${label}`}
      title={`Copy ${text}`}
      containerClassName="min-w-0 max-w-full"
      className="max-w-full truncate rounded px-1 font-mono text-xs text-muted-foreground hover:bg-accent"
    >
      {text}
    </CopyText>
  );
}

/** A folded list: what the site defines but the page does not use, or a framework brings with it. */
function Folded({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2" data-testid={testId}>
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
        {label}
      </Button>
      {open ? children : null}
    </div>
  );
}

function ColourCard({ colour, canvas, onAsk }: { colour: WebsiteStyleColour; canvas: CSSProperties; onAsk: () => void }) {
  return (
    <li className="min-w-0 overflow-hidden rounded-lg border bg-card" data-testid="website-style-colour">
      {/* The colour on the site's own page background, so a see-through colour shows as on the site. */}
      <div className="h-16 border-b" style={{ background: canvas.background }}>
        <div className="h-full w-full" style={{ background: colour.value }} aria-hidden />
      </div>
      <div className="space-y-1 p-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{colour.name}</p>
          {colour.source === "release" ? (
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-micro font-medium text-primary" title={`Set by the release theme: ${colour.token}`}>
              Theme
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1">
          <CopyValue text={colour.hex} label={`${colour.name} hex`} />
          {colour.alpha < 1 ? <span className="text-xs text-muted-foreground">{Math.round(colour.alpha * 100)}%</span> : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1">
          {[colour.cssVar, ...colour.aliases].map((name) => (
            <CopyValue key={name} text={name} label={`${name} variable`} />
          ))}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={colour.usedIn.join(", ")}>
          {colour.usedIn.length ? colour.usedIn.join(", ") : "Not used on the page"}
        </p>
        <AskButton label={colour.name} onAsk={onAsk} />
      </div>
    </li>
  );
}

function ContrastRow({ pair }: { pair: WebsiteStyleContrast }) {
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-lg border bg-card p-2" data-testid="website-style-contrast-pair">
      <span
        className="flex h-10 w-14 shrink-0 items-center justify-center rounded-md border text-base font-semibold"
        style={{ background: pair.background, color: pair.text }}
        aria-hidden
      >
        Aa
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {pair.textName} <span className="text-muted-foreground">on</span> {pair.backgroundName}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground" title={pair.usedIn.join(", ")}>{pair.usedIn.join(", ")}</p>
      </div>
      <span className="shrink-0 text-sm tabular-nums">{pair.ratio.toFixed(1)}:1</span>
      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-xs font-medium", RATING_CLASS[pair.rating])}>
        {pair.rating}
      </span>
    </li>
  );
}

function textSample(text: WebsiteStyleTextStyle): CSSProperties {
  return {
    fontFamily: text.fontFamily ?? undefined,
    fontSize: text.fontSize ?? undefined,
    fontWeight: text.fontWeight ?? undefined,
    lineHeight: text.lineHeight ?? undefined,
    letterSpacing: text.letterSpacing ?? undefined,
    textTransform: (text.textTransform as CSSProperties["textTransform"]) ?? undefined,
    color: text.color ?? undefined,
  };
}

function textMeta(text: WebsiteStyleTextStyle): string {
  return [
    text.fontSize,
    text.fontWeight ? `weight ${text.fontWeight}` : null,
    text.lineHeight ? `line ${text.lineHeight}` : null,
    text.letterSpacing ? `tracking ${text.letterSpacing}` : null,
    text.textTransform && text.textTransform !== "none" ? text.textTransform : null,
  ].filter(Boolean).join(" · ") || "Inherits from the page";
}

const BLOCK_SAMPLE: Record<WebsiteStyleComponent["kind"], string> = {
  button: "Get a quote",
  link: "Read the case study",
  card: "A card on the site",
  pill: "New",
};

/** A base class (`.btn`, `.badge`) sets shape and type but no fill or border; its variants add those. */
function hasNoFill(block: WebsiteStyleComponent): boolean {
  if (block.kind !== "button" && block.kind !== "pill") return false;
  // `border: 1px solid transparent` keeps the size of a bordered variant but draws nothing.
  return !["background", "background-color", "border", "border-color"].some((prop) => block.declarations[prop] && !/^(none|0)$|transparent/.test(block.declarations[prop]));
}

function BlockCard({ block, canvas, onAsk }: { block: WebsiteStyleComponent; canvas: CSSProperties; onAsk: () => void }) {
  const [open, setOpen] = useState(false);
  const declarations = Object.entries(block.declarations);
  return (
    <li className="min-w-0 overflow-hidden rounded-lg border bg-card" data-testid="website-style-block">
      <div className="relative flex min-h-24 items-center justify-center overflow-hidden border-b p-4" style={canvas}>
        {block.kind === "card" ? (
          <div className="w-full max-w-56" style={blockStyle(block.declarations)}>
            <p className="font-semibold">{BLOCK_SAMPLE.card}</p>
            <p className="text-sm opacity-80">With its own padding, border and radius.</p>
          </div>
        ) : block.kind === "link" ? (
          <span style={blockStyle(block.declarations)}>{BLOCK_SAMPLE.link}</span>
        ) : (
          <span className="inline-flex items-center" style={blockStyle(block.declarations)}>{BLOCK_SAMPLE[block.kind]}</span>
        )}
        {hasNoFill(block) ? (
          <span className="absolute bottom-1 left-1 rounded bg-card px-1.5 py-0.5 text-micro text-muted-foreground">No fill (base class)</span>
        ) : null}
      </div>
      <div className="space-y-1 p-3">
        <p className="truncate text-sm font-medium">{block.label}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1">
          {block.className ? <CopyValue text={`class="${block.className}"`} label={`${block.label} class`} /> : <CopyValue text={block.selector} label={`${block.label} selector`} />}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide styles" : `Styles (${declarations.length})`}
          </Button>
          <AskButton label={block.label} onAsk={onAsk} />
        </div>
        {open ? (
          <dl className="space-y-0.5 rounded-md bg-muted/50 p-2 font-mono text-xs">
            {declarations.map(([prop, value]) => (
              <div key={prop} className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-muted-foreground">{prop}</dt>
                <dd className="min-w-0 break-all">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </li>
  );
}

function TokenList({ tokens, onAsk }: { tokens: WebsiteStyleToken[]; onAsk?: (token: WebsiteStyleToken) => void }) {
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {tokens.map((token) => (
        <li key={token.name} className="flex min-w-0 items-center gap-3 px-3 py-2" data-testid="website-style-token">
          <TokenVisual token={token} />
          <div className="min-w-0 flex-1">
            <CopyValue text={token.name} label={`${token.name} name`} />
            <div><CopyValue text={token.value} label={`${token.name} value`} /></div>
          </div>
          {onAsk && token.name.startsWith("--") ? <AskButton label={token.name} onAsk={() => onAsk(token)} /> : null}
        </li>
      ))}
    </ul>
  );
}

function TokenVisual({ token }: { token: WebsiteStyleToken }) {
  if (token.kind === "radius") {
    return <span className="block size-8 shrink-0 border-2 border-primary bg-primary/10" style={{ borderRadius: token.value }} aria-hidden />;
  }
  if (token.kind === "spacing" && /^[\d.]+(px|rem|em)$/.test(token.value)) {
    return (
      <span className="flex h-8 w-24 shrink-0 items-center" aria-hidden>
        <span className="block h-2 max-w-full rounded-sm bg-primary/60" style={{ width: token.value }} />
      </span>
    );
  }
  return null;
}

/** Loads the site's Google Fonts while the tab is open, so the samples draw in the site's fonts. */
function useSiteFonts(hrefs: string[]) {
  const key = hrefs.join(" ");
  useEffect(() => {
    const links = hrefs
      .filter((href) => href.startsWith("https://fonts.googleapis.com/"))
      .map((href) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.dataset.websiteStyleFont = "";
        document.head.appendChild(link);
        return link;
      });
    return () => links.forEach((link) => link.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function WebsiteStyleView({
  style,
  siteName,
  onAsk,
  onReadAgain,
  reading = false,
  compact = false,
}: {
  style: WebsiteSiteStyle;
  siteName: string;
  onAsk: (task: { title: string; description: string }) => void;
  onReadAgain?: () => void;
  reading?: boolean;
  /** In the editor's drawer: one column, whatever the window width. */
  compact?: boolean;
}) {
  const grid = (wide: string) => cn("grid grid-cols-1 gap-3", !compact && wide);
  useSiteFonts(style.fontStylesheets);
  const [allContrast, setAllContrast] = useState(false);
  const canvas = siteCanvas(style);
  const usedColours = style.colours.filter((colour) => !colour.unused);
  const unusedColours = style.colours.filter((colour) => colour.unused);
  const roles = (Object.keys(ROLE_LABELS) as WebsiteStyleColourRole[])
    .map((role) => ({ role, colours: usedColours.filter((colour) => colour.role === role) }))
    .filter((group) => group.colours.length > 0);
  // In the read's order: the pairs that cover most of the page (body text) first.
  const contrast = style.contrast;
  const failing = contrast.filter((pair) => pair.rating === "Fail" || pair.rating === "AA large").length;
  const shownContrast = allContrast ? contrast : contrast.slice(0, CONTRAST_LIMIT);
  const ownTokens = style.tokens.filter((token) => !token.framework);
  const frameworkTokens = style.tokens.filter((token) => token.framework);
  const tokenGroups = (Object.keys(TOKEN_LABELS) as WebsiteStyleTokenKind[])
    .map((kind) => ({ kind, tokens: ownTokens.filter((token) => token.kind === kind && !token.name.startsWith("@keyframes")) }))
    .filter((group) => group.tokens.length > 0);
  const motion = ownTokens.filter((token) => token.name.startsWith("@keyframes"));
  const pageBlocks = style.components.filter((block) => block.inPage);
  const moreBlocks = style.components.filter((block) => !block.inPage);
  const askColour = (colour: WebsiteStyleColour) =>
    onAsk(styleTaskDefaults(siteName, { label: `${colour.name} colour`, name: colour.cssVar, token: colour.token, value: colour.value, usedIn: colour.usedIn }));
  const askBlock = (block: WebsiteStyleComponent) =>
    onAsk(styleTaskDefaults(siteName, { label: block.label, name: block.selector, token: null, value: block.className ? `class="${block.className}"` : block.selector }));
  const swatchGrid = cn("grid grid-cols-2 gap-3", !compact && "lg:grid-cols-3 xl:grid-cols-4");
  const blockGrid = grid("sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4");
  const empty = style.colours.length === 0 && style.fonts.length === 0 && style.components.length === 0;

  return (
    <div className="space-y-8" data-testid="website-style">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">
            Read from{" "}
            <a href={style.siteUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-foreground underline underline-offset-2">
              {style.siteUrl}
            </a>
            {" · "}
            {style.stylesheets.length === 1 ? "1 stylesheet" : `${style.stylesheets.length} stylesheets`}
            {" · "}
            {style.releaseTokenCount === 0 ? "No release theme overrides" : style.releaseTokenCount === 1 ? "1 release theme override" : `${style.releaseTokenCount} release theme overrides`}
            {" · "}
            read {relativeTime(style.readAt)}
          </p>
          <p className="text-xs text-muted-foreground">Click a value to copy it. Theme tokens set in the release win over the stylesheet, as on the site.</p>
        </div>
        {onReadAgain ? (
          <Button type="button" size="sm" variant="outline" onClick={onReadAgain} disabled={reading}>
            <RefreshCw className={cn(reading && "animate-spin motion-reduce:animate-none")} />
            {reading ? "Reading" : "Read again"}
          </Button>
        ) : null}
      </div>

      {style.problem ? (
        <p role="alert" className="rounded-lg border border-status-warning/40 bg-status-warning-soft px-3 py-2 text-sm text-status-warning-foreground" data-testid="website-style-problem">
          {style.problem} {style.colours.length ? "The theme tokens below still show." : ""}
        </p>
      ) : null}

      {empty ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center" data-testid="website-style-empty">
          <Palette className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No colours, fonts or building blocks found yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The site's stylesheet sets no CSS variables on :root and the release theme has no tokens. Publish once, or read again when the site is live.
          </p>
        </div>
      ) : null}

      {style.colours.length ? (
        <Section id="colours" title="Colours" hint="The colours the page uses, by what its rules use them for. Variables with the same value show as one colour.">
          {roles.map(({ role, colours }) => (
            <div key={role} className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">{ROLE_LABELS[role]}</h3>
              {/* Swatches are small: two to a row even on a phone and in the drawer, so the palette reads at a glance. */}
              <ul className={swatchGrid}>
                {colours.map((colour) => (
                  <ColourCard key={colour.cssVar} colour={colour} canvas={canvas} onAsk={() => askColour(colour)} />
                ))}
              </ul>
            </div>
          ))}
          {unusedColours.length ? (
            <Folded label={`Defined but unused (${unusedColours.length})`} testId="website-style-unused-colours">
              <ul className={swatchGrid}>
                {unusedColours.map((colour) => (
                  <ColourCard key={colour.cssVar} colour={colour} canvas={canvas} onAsk={() => askColour(colour)} />
                ))}
              </ul>
            </Folded>
          ) : null}
        </Section>
      ) : null}

      {contrast.length ? (
        <Section
          id="contrast"
          title="Text on background"
          hint={`Each text colour on the background it sits on, the most of the page first. Body text needs AA (4.5:1); AA large is for headings only. ${failing ? `${failing} of ${contrast.length} pairs are below AA.` : "Every pair passes AA."}`}
        >
          <ul className={cn("grid grid-cols-1 gap-2", !compact && "lg:grid-cols-2")}>
            {shownContrast.map((pair) => (
              <ContrastRow key={`${pair.text} ${pair.background}`} pair={pair} />
            ))}
          </ul>
          {contrast.length > CONTRAST_LIMIT ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setAllContrast(!allContrast)}>
              {allContrast ? "Show fewer" : `Show all ${contrast.length} pairs`}
            </Button>
          ) : null}
        </Section>
      ) : null}

      {style.fonts.length || style.textStyles.length ? (
        <Section id="fonts" title="Fonts" hint="The families the site uses and its type scale, drawn live in the site's fonts.">
          {style.fonts.length ? (
            <ul className={grid("sm:grid-cols-2 lg:grid-cols-3")}>
              {style.fonts.map((font) => (
                <li key={font.family} className="min-w-0 overflow-hidden rounded-lg border bg-card" data-testid="website-style-font">
                  <div className="border-b px-4 py-3" style={{ ...canvas, fontFamily: font.stack }}>
                    <p className="truncate text-3xl">Aa Bb Gg 123</p>
                  </div>
                  <div className="space-y-1 p-3">
                    <p className="truncate text-sm font-medium">{font.family}</p>
                    <CopyValue text={font.stack} label={`${font.family} font stack`} />
                    <p className="text-xs text-muted-foreground">
                      {font.weights.length ? `Weights ${font.weights.join(", ")}` : "Weights not listed"}
                      {" · "}
                      {font.loadedFrom === "google" ? "Google Fonts" : font.loadedFrom === "font-face" ? "The site's own font files" : "System font"}
                      {font.usedIn.length ? ` · ${font.usedIn.slice(0, 3).join(", ")}` : ""}
                    </p>
                    {font.loadedFrom === "font-face" ? (
                      <p className="text-xs text-muted-foreground">Drawn here with the fallback; the site loads its own files.</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {style.textStyles.length ? (
            <ol className="overflow-hidden rounded-lg border" style={canvas} data-testid="website-style-type-scale">
              {style.textStyles.map((text) => (
                <li key={text.selector} className={cn("flex flex-col gap-2 border-b p-4 last:border-b-0", !compact && "md:flex-row md:gap-4")}>
                  {/* The meta reads in GSAM's own card colours; the sample in the site's. */}
                  <div className={cn("min-w-0 self-start rounded-md bg-card p-2 text-card-foreground", !compact && "md:w-48 md:shrink-0")}>
                    <p className="text-sm font-medium">{text.label}</p>
                    <p className="font-mono text-xs text-muted-foreground">{text.selector}</p>
                    <p className="text-xs text-muted-foreground">{textMeta(text)}</p>
                  </div>
                  <p className="min-w-0 flex-1 break-words" style={textSample(text)}>
                    {text.selector.startsWith("h") ? "Software that ships on time" : "The quick brown fox jumps over the lazy dog, and the release goes out on Friday."}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
        </Section>
      ) : null}

      {style.components.length ? (
        <Section id="blocks" title="Building blocks" hint="The buttons, links, cards and pills the page uses, as the stylesheet draws them, with the class to use.">
          {pageBlocks.length ? (
            <ul className={blockGrid}>
              {pageBlocks.map((block) => (
                <BlockCard key={block.selector} block={block} canvas={canvas} onAsk={() => askBlock(block)} />
              ))}
            </ul>
          ) : null}
          {moreBlocks.length ? (
            <Folded label={`More variants the stylesheet defines (${moreBlocks.length})`} testId="website-style-more-blocks">
              <ul className={blockGrid}>
                {moreBlocks.map((block) => (
                  <BlockCard key={block.selector} block={block} canvas={canvas} onAsk={() => askBlock(block)} />
                ))}
              </ul>
            </Folded>
          ) : null}
        </Section>
      ) : null}

      {tokenGroups.length || frameworkTokens.length ? (
        <Section id="tokens" title="Radius, spacing and other tokens">
          <div className={cn("grid grid-cols-1 gap-4", !compact && "lg:grid-cols-2")}>
            {tokenGroups.map(({ kind, tokens }) => (
              <div key={kind} className="min-w-0 space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">{TOKEN_LABELS[kind]}</h3>
                <TokenList tokens={tokens} onAsk={(token) => onAsk(styleTaskDefaults(siteName, { label: token.name, name: token.name, token: token.token, value: token.value }))} />
              </div>
            ))}
          </div>
          {frameworkTokens.length ? (
            <Folded label={`From frameworks or not used on the page (${frameworkTokens.length})`} testId="website-style-framework-tokens">
              {/* Breakpoints, library sizes and keyframes: listed for reference, no Ask an agent. */}
              <TokenList tokens={frameworkTokens} />
            </Folded>
          ) : null}
        </Section>
      ) : null}

      {style.surfaces.length || motion.length ? (
        <Section id="surfaces" title="Backgrounds and effects" hint="The site's background surfaces and the motion it uses. The effects library comes as its own page.">
          {style.surfaces.length ? (
            <ul className={grid("sm:grid-cols-2 lg:grid-cols-4")}>
              {style.surfaces.map((surface) => (
                <li key={surface.selector} className="min-w-0 overflow-hidden rounded-lg border bg-card" data-testid="website-style-surface">
                  <div className="h-20 border-b" style={{ background: canvas.background }}>
                    <div className="h-full w-full" style={{ background: /url\(/i.test(surface.background) ? undefined : surface.background }} aria-hidden />
                  </div>
                  <div className="space-y-1 p-3">
                    <p className="truncate text-sm font-medium">{surface.label}</p>
                    <CopyValue text={surface.selector} label={`${surface.label} selector`} />
                    <p className="line-clamp-2 break-all font-mono text-xs text-muted-foreground" title={surface.background}>{surface.background}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {motion.length ? (
            <p className="text-sm text-muted-foreground">
              Motion the page runs: {motion.map((token) => token.name.replace(/^@keyframes /, "")).join(", ")}.
            </p>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

/** The style read for one site, loading, failed or shown. The Style tab and the editor's Style drawer use it. */
export function WebsiteStyleForSite({
  companyId,
  site,
  projectId,
  compact = false,
}: {
  companyId: string;
  site: Pick<WebsiteSite, "id" | "name">;
  /** The website's project: Ask an agent files the task there. */
  projectId?: string | null;
  compact?: boolean;
}) {
  const { openNewIssue } = useDialogActions();
  const queryClient = useQueryClient();
  const key = queryKeys.website.style(companyId, site.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => websiteModuleApi.style(companyId, site.id),
    staleTime: 5 * 60_000,
  });
  const readAgain = useMutation({
    mutationFn: () => websiteModuleApi.style(companyId, site.id, true),
    onSuccess: (style) => queryClient.setQueryData(key, style),
  });

  if (query.isLoading) return <StyleLoading compact={compact} />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error} title="The site's style could not be read" onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  return (
    <WebsiteStyleView
      style={query.data}
      siteName={site.name}
      compact={compact}
      onAsk={(task) => openNewIssue({ projectId: projectId ?? undefined, ...task })}
      onReadAgain={() => readAgain.mutate()}
      reading={readAgain.isPending}
    />
  );
}

function StyleLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-4" aria-busy="true" data-testid="website-style-loading">
      <p className="text-sm text-muted-foreground">Reading the site's stylesheet…</p>
      <div className={cn("grid grid-cols-1 gap-3", !compact && "sm:grid-cols-2 lg:grid-cols-4")}>
        {Array.from({ length: compact ? 2 : 4 }, (_, index) => (
          <div key={index} className="h-36 animate-pulse rounded-lg border bg-muted motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

export function WebsiteStyleTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site, isLoading } = useWebsiteSite(companyId, property.id);
  if (isLoading) return <StyleLoading />;
  if (!site) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center" data-testid="website-style-no-site">
        <p className="text-sm font-medium">Connect the site first</p>
        <p className="text-sm text-muted-foreground">The Style tab reads the connected site's stylesheet and release theme.</p>
      </div>
    );
  }
  return <WebsiteStyleForSite companyId={companyId} site={site} projectId={property.projectId} />;
}
