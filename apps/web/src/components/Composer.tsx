import { useState } from "react";
import { useInterruptSession, useSendMessage } from "../api/queries";

export function Composer({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [text, setText] = useState("");
  const sendMessage = useSendMessage(sessionId);
  const interrupt = useInterruptSession(sessionId);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage.mutate(trimmed);
    setText("");
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-surface p-2">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Message the agent…"
          rows={1}
          disabled={disabled}
          className="max-h-32 flex-1 resize-none rounded-md border border-border bg-surface-raised px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !text.trim() || sendMessage.isPending}
          data-testid="send-button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          Send
        </button>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => interrupt.mutate()}
          disabled={disabled || interrupt.isPending}
          className="rounded-md border border-warn px-3 py-1 text-xs font-medium text-warn disabled:opacity-50"
        >
          Interrupt
        </button>
        <button
          type="button"
          disabled
          title="Coming later in Phase 5"
          className="rounded-md border border-border px-3 py-1 text-xs font-medium text-ink-dim opacity-50"
        >
          Handoff
        </button>
      </div>
    </div>
  );
}
