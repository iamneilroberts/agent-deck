import type { FileChangedItem } from "../buildTimeline";

const BADGE: Record<FileChangedItem["changeType"], string> = {
  added: "text-ok",
  modified: "text-warn",
  deleted: "text-danger",
};

export function FileChangedCard({ item }: { item: FileChangedItem }) {
  return (
    <div
      data-testid="timeline-item-file_changed"
      className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm"
    >
      <span className={`mr-2 font-mono text-xs uppercase ${BADGE[item.changeType]}`}>
        {item.changeType}
      </span>
      <span className="font-mono text-xs">{item.path}</span>
    </div>
  );
}
