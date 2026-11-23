// Copies the Aura company template into the package (GRE-6097, template from
// GRE-6096): the feature-request address goes into John's instructions, then
// the leak check runs on the result. Any leak stops the build.
//
//   tsx scripts/aura-macos/prepare-template.ts <out dir> <feature-request address>

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readTemplateFiles,
  templateFeaturesOn,
  templateLeaks,
  withFeatureRequestAddress,
} from "../client-instance/aura-template.js";

const [outDir, address] = process.argv.slice(2);
if (!outDir || !address) {
  console.error("usage: prepare-template.ts <out dir> <feature-request address>");
  process.exit(2);
}

const files = withFeatureRequestAddress(readTemplateFiles(), address);
const leaks = templateLeaks(files, address);
if (leaks.length > 0) {
  for (const leak of leaks) console.error(`LEAK ${leak.file}:${leak.line} ${leak.label}`);
  process.exit(1);
}
const features = templateFeaturesOn(files);
for (const [file, text] of Object.entries(files)) {
  const target = path.join(outDir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}
// The installer reads this list; it turns each switch on before the import.
writeFileSync(path.join(path.dirname(outDir), "aura-features-on.txt"), `${features.join("\n")}\n`);
console.log(`template ready: ${Object.keys(files).length} files, switches on: ${features.join(", ") || "none"}`);
