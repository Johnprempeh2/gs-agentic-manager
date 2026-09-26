import type { CLIAdapterModule } from "@greatstone/adapter-utils";
import { printProcessStdoutEvent } from "./format-event.js";

export const processCLIAdapter: CLIAdapterModule = {
  type: "process",
  formatStdoutEvent: printProcessStdoutEvent,
};
