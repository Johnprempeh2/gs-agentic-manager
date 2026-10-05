import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ReactNode } from "react";
import type { MemoryRecordStatus, MemoryScope } from "@greatstone/shared";
import { memoryStatusMeta, scopeKindLabel } from "./memoryLabels";

const ALL = "all";

export interface MemoryFilterAgent {
  id: string;
  name: string;
}

/** The filters both memory views share. */
export interface MemoryCommonFilters<S extends MemoryRecordStatus = MemoryRecordStatus> {
  q?: string;
  agentId?: string;
  scopeId?: string;
  status?: S;
}

interface MemoryFilterBarProps<S extends MemoryRecordStatus> {
  filters: MemoryCommonFilters<S>;
  statuses: readonly S[];
  /** Raw text in the search box; the page debounces it into `filters.q`. */
  searchText: string;
  onSearchTextChange: (value: string) => void;
  onChange: (next: MemoryCommonFilters<S>) => void;
  agents: MemoryFilterAgent[];
  scopes: MemoryScope[];
  /** Extra controls after the status filter, e.g. a date range. */
  children?: ReactNode;
}

export function MemoryFilterBar<S extends MemoryRecordStatus>({
  filters,
  statuses,
  searchText,
  onSearchTextChange,
  onChange,
  agents,
  scopes,
  children,
}: MemoryFilterBarProps<S>) {
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
        onValueChange={(value) => onChange({ ...filters, status: value === ALL ? undefined : (value as S) })}
      >
        <SelectTrigger className="h-9 w-full sm:w-40" aria-label="Review status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {statuses.map((status) => (
            <SelectItem key={status} value={status}>{memoryStatusMeta[status].label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {children}
    </div>
  );
}
