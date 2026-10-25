/**
 * The Website Style read (GRE-2520): the site's colours, fonts and building blocks,
 * read from the site's own deployed stylesheet and its release theme tokens. Never a
 * hand-typed copy. The same answer feeds the Style tab and the agents' read tool.
 */

/** What a colour is for, from where the stylesheet uses it (or its name when it is not used). */
export type WebsiteStyleColourRole = "background" | "text" | "accent" | "border" | "status" | "other";

/** Where a value came from: a release theme token (wins, as on the site) or the stylesheet default. */
export type WebsiteStyleSource = "release" | "stylesheet";

export interface WebsiteStyleColour {
  /** The CSS variable, e.g. `--gs-accent`. */
  cssVar: string;
  /** The release theme token that sets it, e.g. `gs.accent`; null when only the stylesheet sets it. */
  token: string | null;
  /** A readable name from the variable, e.g. "Accent dim". */
  name: string;
  /** The value as the site writes it, e.g. `rgba(200,255,0,.1)`. */
  value: string;
  /** `#rrggbb`, without alpha. */
  hex: string;
  /** 0 to 1. */
  alpha: number;
  role: WebsiteStyleColourRole;
  /** The kinds of property it is used in: text, background, border, shadow, other. Empty when unused. */
  usedFor: string[];
  /** Up to four selectors that use it. */
  usedIn: string[];
  source: WebsiteStyleSource;
}

export type WebsiteStyleContrastRating = "AAA" | "AA" | "AA large" | "Fail";

/** One text colour on one background colour (WCAG 2 contrast ratio, alpha composited on the page background). */
export interface WebsiteStyleContrast {
  text: string;
  background: string;
  ratio: number;
  rating: WebsiteStyleContrastRating;
}

export interface WebsiteStyleFont {
  /** The first family in the stack, e.g. `Montserrat`. */
  family: string;
  /** The whole stack as written. */
  stack: string;
  /** Weights the site loads for it (Google Fonts or @font-face), ascending. Empty when unknown. */
  weights: number[];
  /** Selectors that set it, e.g. `body`. */
  usedIn: string[];
  /** `google`: a Google Fonts stylesheet; `font-face`: the site's own @font-face; `system`: neither. */
  loadedFrom: "google" | "font-face" | "system";
}

/** One step of the type scale, as the site's stylesheet sets it. Null: not set by that rule. */
export interface WebsiteStyleTextStyle {
  /** The selector, e.g. `h1` or `.lead`. */
  selector: string;
  label: string;
  fontFamily: string | null;
  fontSize: string | null;
  fontWeight: string | null;
  lineHeight: string | null;
  letterSpacing: string | null;
  textTransform: string | null;
  color: string | null;
}

export type WebsiteStyleComponentKind = "button" | "link" | "card" | "pill";

/** A building block the stylesheet defines, with the class to use and its own declarations. */
export interface WebsiteStyleComponent {
  kind: WebsiteStyleComponentKind;
  /** The rule's selector, e.g. `.btn--primary`. */
  selector: string;
  /** The classes a page puts on the element, e.g. `btn btn--primary`. */
  className: string;
  label: string;
  /** The rule's declarations, property to value, in stylesheet order. */
  declarations: Record<string, string>;
}

export type WebsiteStyleTokenKind = "radius" | "spacing" | "size" | "motion" | "other";

/** A non-colour token: a CSS variable, or a radius or spacing value a building block uses. */
export interface WebsiteStyleToken {
  /** The CSS variable, or the component property it was read from, e.g. `.card border-radius`. */
  name: string;
  token: string | null;
  value: string;
  kind: WebsiteStyleTokenKind;
  source: WebsiteStyleSource;
}

/** A background surface: the page itself or a section or box class with its own background. */
export interface WebsiteStyleSurface {
  selector: string;
  label: string;
  background: string;
}

export interface WebsiteSiteStyle {
  siteId: string;
  /** The address read, e.g. `https://example.com/`. */
  siteUrl: string;
  readAt: string;
  /** The site's own stylesheets that were read. */
  stylesheets: string[];
  /** Font stylesheets (Google Fonts) the site links; the Style tab loads them to draw the fonts. */
  fontStylesheets: string[];
  /** How many tokens the release theme sets. */
  releaseTokenCount: number;
  /** Why the site's stylesheet could not be read; the release theme tokens still show. Null when it was read. */
  problem: string | null;
  colours: WebsiteStyleColour[];
  contrast: WebsiteStyleContrast[];
  fonts: WebsiteStyleFont[];
  textStyles: WebsiteStyleTextStyle[];
  components: WebsiteStyleComponent[];
  tokens: WebsiteStyleToken[];
  surfaces: WebsiteStyleSurface[];
}
