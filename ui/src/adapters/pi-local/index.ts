import type { UIAdapterModule } from "../types";
import { parsePiStdoutLine } from "@greatstone/adapter-pi-local/ui";
import { PiLocalConfigFields } from "./config-fields";
import { buildPiLocalConfig } from "@greatstone/adapter-pi-local/ui";

export const piLocalUIAdapter: UIAdapterModule = {
  type: "pi_local",
  label: "Pi",
  parseStdoutLine: parsePiStdoutLine,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPiLocalConfig,
};
