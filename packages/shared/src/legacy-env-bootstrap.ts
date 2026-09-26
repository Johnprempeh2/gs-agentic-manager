/**
 * Side-effect import: adopt legacy environment names before anything reads
 * process.env. Import it FIRST in every process entry point (ESM evaluates
 * imports in order, so later modules see the adopted GSAM_* values).
 */
import { adoptLegacyEnv } from "./legacy-env.js";

adoptLegacyEnv();
