import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MEMORY_GRAPH_STATUSES, type MemoryGraphStatus, type MemoryScope } from "@greatstone/shared";
import type { MemoryGraphFilters } from "../../api/memoryGraph";
import { memoryStatusMeta, scopeKindLabel } from "./memoryLabels";

const ALL = "all";

export interface MemoryFilterAgent {
  id: string;
  name: string;
}

interface MemoryFilterBarProps {
  filters: MemoryGraphFilters;
  /** Raw text in the search box; the page debounces it into `filters.q`. */
  searchText: string;
  onSearchTextChange: (value: string) => void;
  onChange: (next: MemoryGraphFilters) => void;
  agents: MemoryFilterAgent[];
  scopes: MemoryScope[];
}

export function MemoryFilterBar({ filters, searchText, onSearchTextChange, onChange, agents, scopes }: MemoryFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter memory">
      <div className="relative min-w-0 flex-1 basis-56">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={searchText}
          onChange={(event) => onSearchTextChange(event.target.value)}
          placeholder="Search memory"
          aria-label="Search memory"
          className="h-9 pl-8"
        />
      </div>
      <Select value={filters.agentId ?? ALL} onValueChange={(value) => onChange({ ...filters, agentId: value === ALL ? undefined : value })}>
        <SelectTrigger className="h-9 w-full sm:w-44" aria-label="Agent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All agents</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.scopeId ?? ALL} onValueChange={(value) => onChange({ ...filters, scopeId: value === ALL ? undefined : value })}>
        <SelectTrigger className="h-9 w-full sm:w-52" aria-label="Project or client scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All scopes</SelectItem>
          {scopes.map((scope) => (
            <SelectItem key={scope.id} value={scope.id}>
              {scope.name} <span className="text-muted-foreground">· {scopeKindLabel[scope.kind]}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.status ?? ALL}
        onValueChange={(value) => onChange({ ...filters, status: value === ALL ? undefined : (value as MemoryGraphStatus) })}
      >
        <SelectTrigger className="h-9 w-full sm:w-40" aria-label="Review status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {MEMORY_GRAPH_STATUSES.map((status) => (
            <SelectItem key={status} value={status}>{memoryStatusMeta[status].label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
