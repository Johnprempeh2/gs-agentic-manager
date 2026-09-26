#!/usr/bin/env node
import { runServer } from "./index.js";

void runServer().catch((error) => {
  console.error("Failed to start GS Agentic Manager MCP server:", error);
  process.exit(1);
});
