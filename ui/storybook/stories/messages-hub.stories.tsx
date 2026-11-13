import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChatPrototype } from "../prototypes/agent-chat/AgentChatPrototype";
import { OPS_ROOM_ID } from "../prototypes/messages-hub/messagesHubFixtures";

/**
 * Messages (John, 13 Nov): the Everest orb opens a familiar two-pane
 * messenger. The real Layout, sidebar, MessagesPane, agent chat and team chat
 * pages over an in-memory API with demo agents and people. The sidebar keeps
 * only Everest, pinned chats and All messages.
 */
function OpenNewMessage() {
  useEffect(() => {
    const timer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="new-message"]');
      if (!button) return;
      button.click();
      window.clearInterval(timer);
    }, 300);
    return () => window.clearInterval(timer);
  }, []);
  return null;
}

const meta = {
  title: "Product/Messages hub",
  component: AgentChatPrototype,
  parameters: { layout: "fullscreen" },
  render: (args) => <AgentChatPrototype key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof AgentChatPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AgentThreadTyping: Story = {
  name: "01 · Agent thread: approval card, typing",
  args: { scenario: "working", messagesPath: "chats/agent-codex", contextInitiallyOpen: false },
};
export const TeamThread: Story = {
  name: "02 · Group chat",
  args: { scenario: "returning", messagesPath: `messages/${OPS_ROOM_ID}`, contextInitiallyOpen: false },
};
export const List: Story = {
  name: "03 · Messages list (phones: the first screen)",
  args: { scenario: "returning", messagesPath: "messages", contextInitiallyOpen: false },
};
export const NewMessage: Story = {
  name: "04 · New message",
  args: { scenario: "returning", messagesPath: "messages", contextInitiallyOpen: false },
  render: (args) => (
    <>
      <AgentChatPrototype {...args} />
      <OpenNewMessage />
    </>
  ),
};
