import type { ErrorItem } from "../buildTimeline";

export function ErrorCard({ item }: { item: ErrorItem }) {
  return (
    <div
      data-testid="timeline-item-error"
      className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      <div className="font-medium">Error</div>
      <div>{item.message}</div>
      {item.recoverable && <div className="mt-1 text-xs text-ink-dim">Agent may retry.</div>}
    </div>
  );
}
