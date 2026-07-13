import type { GenericItem } from "../buildTimeline";

/** Covers event types with no dedicated card: session_started, session_status_changed,
 * tool_started, tool_output, user_input_requested. Renders a short label — never dropped
 * silently, per the "unknown output is preserved, never guessed" contract rule. */
function describe(item: GenericItem): string {
  const event = item.event;
  switch (event.type) {
    case "session_started":
      return `Session started${event.model ? ` (${event.model})` : ""}`;
    case "session_status_changed":
      return `Status: ${event.previous ? `${event.previous} → ` : ""}${event.status}`;
    case "tool_started":
      return `Tool: ${event.toolName}`;
    case "tool_output":
      return `Tool result${event.ok === false ? " (failed)" : ""}`;
    case "user_input_requested":
      return event.prompt;
    default:
      return event.type;
  }
}

export function GenericEventCard({ item }: { item: GenericItem }) {
  return (
    <div
      data-testid={`timeline-item-${item.event.type}`}
      className="rounded-lg border border-border/60 bg-transparent px-3 py-1.5 text-xs text-ink-dim"
    >
      {describe(item)}
    </div>
  );
}
