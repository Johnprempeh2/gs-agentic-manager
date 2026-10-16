import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { memoryGraphApi } from "../../api/memoryGraph";
import { useCompany } from "../../context/CompanyContext";
import { downloadTextFile } from "../../lib/issues-csv";
import {
  MEMORY_BACKUP_PAGE,
  collectMemoryBackup,
  memoryBackupFileName,
  memoryBackupText,
} from "../../lib/memory-backup";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Format = "json" | "txt";

/** Saves every entry the reader may see to a file, as a backup or to read offline. */
export function MemoryBackupButton() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");

  async function save(format: Format) {
    if (!selectedCompanyId) return;
    setState("working");
    try {
      const now = new Date();
      const name = selectedCompany?.name ?? "";
      const backup = await collectMemoryBackup(
        (cursor) => memoryGraphApi.activity(selectedCompanyId, { cursor, limit: String(MEMORY_BACKUP_PAGE) }),
        name,
        now,
      );
      const fileName = memoryBackupFileName(name, now, format);
      if (format === "json") downloadTextFile(fileName, `${JSON.stringify(backup, null, 2)}\n`, "application/json");
      else downloadTextFile(fileName, memoryBackupText(backup), "text/plain;charset=utf-8");
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={!selectedCompanyId || state === "working"} data-testid="memory-backup">
          {state === "working" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {state === "working" ? "Saving..." : state === "failed" ? "Could not save, try again" : "Download backup"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void save("txt")}>As text you can read</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void save("json")}>As a full backup file (JSON)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
