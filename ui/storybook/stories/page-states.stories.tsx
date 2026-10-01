import type { Meta, StoryObj } from "@storybook/react-vite";
import { ListTodo } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";

/** The three shared page states every page uses: loading, empty and error (GRE-307). */
function PageStates() {
  return (
    <div className="grid gap-6 p-6 lg:grid-cols-2">
      <section className="paperclip-story__frame p-5">
        <div className="paperclip-story__label mb-4">Loading · PageSkeleton</div>
        <PageSkeleton variant="list" />
      </section>
      <section className="paperclip-story__frame p-5">
        <div className="paperclip-story__label">Empty · EmptyState</div>
        <EmptyState
          icon={ListTodo}
          message="No tasks yet"
          description="Tasks you create or are given show up here."
          action="Create task"
          onAction={() => {}}
        />
      </section>
      <section className="paperclip-story__frame p-5">
        <div className="paperclip-story__label">Error · ErrorState</div>
        <ErrorState error={new Error("The server did not answer. Check your connection.")} onRetry={() => {}} />
      </section>
      <section className="paperclip-story__frame p-5">
        <div className="paperclip-story__label">Error · ErrorState compact (refresh failed)</div>
        <ErrorState error={new Error("Showing the last list we loaded.")} onRetry={() => {}} compact />
      </section>
    </div>
  );
}

const meta = {
  title: "Foundations/Page States",
  component: PageStates,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PageStates>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllStates: Story = {};
