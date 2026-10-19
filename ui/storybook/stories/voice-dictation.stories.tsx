import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatComposer } from "@/components/ChatComposer";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import {
  FakeSpeechRecognition,
  installFakeSpeechRecognition,
} from "@/fixtures/fakeSpeechRecognition";

// Storybook browsers may lack speech recognition; the fake keeps the mic visible.
installFakeSpeechRecognition();

const SHORT_PHRASE = "invoice for Acme before Friday";
const LONG_PHRASE =
  "invoice for Acme before Friday and then send the signed copy to finance with a note that the second payment moves to the end of next month";

function DictationExample({ listening, phrase = SHORT_PHRASE }: { listening: boolean; phrase?: string }) {
  const [boardDraft, setBoardDraft] = useState("Can you check the");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listening) return;
    const mics = rootRef.current?.querySelectorAll<HTMLButtonElement>('button[aria-label="Dictate message"]');
    mics?.forEach((mic) => mic.click());
    const timer = window.setTimeout(() => {
      for (const recognition of FakeSpeechRecognition.instances) {
        recognition.hear(phrase, false);
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, [listening, phrase]);

  return (
    <div ref={rootRef} className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Task chat</h2>
        <TaskChatComposer onAdd={async () => {}} workMode="standard" />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Board chat</h2>
        <ChatComposer
          value={boardDraft}
          onChange={setBoardDraft}
          onSubmit={() => setBoardDraft("")}
          submitKey="enter"
          onAttachFiles={() => {}}
        />
      </section>
    </div>
  );
}

const meta = {
  title: "Chat/Voice dictation",
  component: DictationExample,
  parameters: {
    docs: {
      description: {
        component:
          "Mic button in the chat composers (GRE-1669). Click to speak; heard words are added to the draft and nothing sends by itself. The mic hides when the browser has no speech recognition.",
      },
    },
  },
  args: { listening: false },
} satisfies Meta<typeof DictationExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};
export const Listening: Story = { args: { listening: true } };
/** Long speech wraps to two lines and keeps the newest words in view. */
export const ListeningLongSpeech: Story = { args: { listening: true, phrase: LONG_PHRASE } };
