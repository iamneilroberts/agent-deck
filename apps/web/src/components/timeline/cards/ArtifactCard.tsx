import type { ArtifactItem } from "../buildTimeline";

export function ArtifactCard({ item }: { item: ArtifactItem }) {
  return (
    <div
      data-testid="timeline-item-artifact_created"
      className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm"
    >
      <span className="mr-2 text-xs uppercase text-ink-dim">{item.artifactType}</span>
      <span className="font-mono text-xs break-all">{item.path}</span>
    </div>
  );
}
