import type { MessageItem } from "../buildTimeline";

const STYLES: Record<MessageItem["kind"], string> = {
  user_message: "bg-accent/15 border-accent/40 ml-6",
  assistant_message: "bg-surface-raised border-border mr-6",
  reasoning: "bg-surface border-border/60 mr-6 italic text-ink-dim",
};

const LABELS: Record<MessageItem["kind"], string> = {
  user_message: "You",
  assistant_message: "Agent",
  reasoning: "Reasoning",
};

export function MessageCard({ item }: { item: MessageItem }) {
  return (
    <div
      data-testid={`timeline-item-${item.kind}`}
      className={`rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap break-words ${STYLES[item.kind]}`}
    >
      <div className="mb-1 text-xs font-medium text-ink-dim">
        {LABELS[item.kind]}
        {!item.complete && <span className="ml-1 animate-pulse">…</span>}
      </div>
      {item.text || <span className="text-ink-dim">…</span>}
    </div>
  );
}
