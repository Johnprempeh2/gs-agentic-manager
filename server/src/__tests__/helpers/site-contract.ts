// The GSAM and website contract (GRE-2633) for tests: its manifest, its shared
// fixtures, and a JSON Schema check for each surface. The same files are
// vendored into the website, whose tests check its answers against them.
import { readFileSync } from "node:fs";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const ROOT = new URL("../../../../contracts/", import.meta.url);

export interface SiteContractManifest {
  name: string;
  version: number;
  minSiteVersion: number;
  surfaces: Record<string, Record<string, unknown> & { schema?: string; fixture?: string }>;
  files: Record<string, string>;
  contentHash: string;
}

export const readContractFile = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));

export const siteContractManifest = readContractFile("manifest.json") as SiteContractManifest;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ allErrors: true, strict: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
((addFormats as any).default ?? addFormats)(ajv);
const compiled = new Map<string, ValidateFunction>();

/** The JSON Schema check for one surface of the manifest, for example `deepDiveSync`. */
export function contractSchema(surface: string): ValidateFunction {
  const path = siteContractManifest.surfaces[surface]?.schema;
  if (!path) throw new Error(`the contract has no schema for ${surface}`);
  let validate = compiled.get(path);
  if (!validate) {
    validate = ajv.compile(readContractFile(path) as object) as ValidateFunction;
    compiled.set(path, validate);
  }
  return validate;
}

/** The shared fixture for one surface. */
export function contractFixture<T = Record<string, unknown>>(surface: string): T {
  const path = siteContractManifest.surfaces[surface]?.fixture;
  if (!path) throw new Error(`the contract has no fixture for ${surface}`);
  return readContractFile(path) as T;
}

/** The schema's errors for `value` as one line, or null when it passes. */
export function contractErrors(surface: string, value: unknown): string | null {
  const validate = contractSchema(surface);
  return validate(value) ? null : ajv.errorsText(validate.errors);
}
