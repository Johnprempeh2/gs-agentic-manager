/**
 * Greatstone (GRE-1441): Streamlined UI graduated out of Settings > Experimental.
 * The streamlined shell is the only experience: the stored
 * `enableStreamlinedUi` value is a compatibility key and is ignored, so the
 * app never waits on settings or falls back to the legacy shell.
 */
export function useStreamlinedUiEnabled(): { enabled: boolean; loaded: boolean } {
  return { enabled: true, loaded: true };
}
