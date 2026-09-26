import pc from "picocolors";

const GSAM_ART = [
  " ██████╗ ███████╗ █████╗ ███╗   ███╗",
  "██╔════╝ ██╔════╝██╔══██╗████╗ ████║",
  "██║  ███╗███████╗███████║██╔████╔██║",
  "██║   ██║╚════██║██╔══██║██║╚██╔╝██║",
  "╚██████╔╝███████║██║  ██║██║ ╚═╝ ██║",
  " ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝",
] as const;

const TAGLINE = "Goals, tasks, budgets and approvals for teams of AI agents. By Greatstone.";

export function printPaperclipCliBanner(): void {
  const lines = [
    "",
    ...GSAM_ART.map((line) => pc.green(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
