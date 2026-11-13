import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectDeliverablesDesignExamples } from "@/components/deliverables/ProjectDeliverablesDesignExamples";

// The project Deliverables tab (Ben, 10 Nov), with demo data and no client
// names: stage badges, the filters and cards, an older release with its
// banner, project and client with the move control, and the release timeline.

const meta = {
  title: "Projects/Deliverables tab",
  component: ProjectDeliverablesDesignExamples,
  decorators: [(Story) => <div className="mx-auto w-full max-w-7xl p-4"><Story /></div>],
} satisfies Meta<typeof ProjectDeliverablesDesignExamples>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Dark: Story = { globals: { theme: "dark" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
