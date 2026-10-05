import { useNavigate } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../PageTabBar";

export type MemoryTab = "connections" | "contributions";

const TAB_PATH: Record<MemoryTab, string> = {
  connections: "/memory",
  contributions: "/memory/activity",
};

/** Title and the two views of the Memory page. Switching view keeps no selection. */
export function MemoryPageHeader({ tab }: { tab: MemoryTab }) {
  const navigate = useNavigate();
  const onChange = (value: string) => navigate(TAB_PATH[value as MemoryTab] ?? "/memory");
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h1 className="text-xl font-bold">Memory</h1>
        <p className="text-sm text-muted-foreground">
          What agents and people have added to shared memory, and how entries connect.
        </p>
      </div>
      <Tabs value={tab} onValueChange={onChange}>
        <PageTabBar
          align="start"
          ariaLabel="Memory view"
          value={tab}
          onValueChange={onChange}
          items={[
            { value: "connections", label: "Connections" },
            { value: "contributions", label: "Contributions" },
          ]}
        />
      </Tabs>
    </div>
  );
}
