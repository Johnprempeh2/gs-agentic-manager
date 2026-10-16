import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * The board secretary agent (GRE-1200), one per instance. It may make draft
 * board packs; a board member accepts them. Chosen from the selected
 * company's agents.
 */
export function BoardSecretarySetting({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (agentId: string | null) => void;
  disabled: boolean;
}) {
  const { selectedCompanyId } = useCompany();
  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const choices = (agents ?? []).filter((agent) => agent.status !== "terminated" || agent.id === value);
  const known = value == null || choices.some((agent) => agent.id === value);
  return (
    <Card className="block bg-transparent p-5">
      <div className="space-y-1.5">
        <Label htmlFor="board-secretary-agent" className="text-sm font-semibold">Board secretary agent</Label>
        <p className="max-w-2xl text-sm text-muted-foreground">
          This agent may make a draft board pack. A board member must accept the draft before it is the meeting's pack.
          Other agents cannot make board packs.
        </p>
        <NativeSelect
          id="board-secretary-agent"
          className="max-w-sm"
          value={value ?? ""}
          disabled={disabled || isLoading || !selectedCompanyId}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">No board secretary</option>
          {!known ? <option value={value!}>An agent in another company</option> : null}
          {choices.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </NativeSelect>
        {error ? <p className="text-xs text-status-danger">Could not load the agents: {(error as Error).message}</p> : null}
      </div>
    </Card>
  );
}
