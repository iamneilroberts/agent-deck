import { useState } from "react";
import type { CommandItem } from "../buildTimeline";

/** Collapsed by default — commands can produce a lot of noise on a phone screen. */
export function CommandCard({ item }: { item: CommandItem }) {
  const [expanded, setExpanded] = useState(false);
  const output = item.output.map((chunk) => chunk.chunk).join("");
  const failed = item.exitCode != null && item.exitCode !== 0;

  return (
    <div
      data-testid="timeline-item-command"
      className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left font-mono text-xs"
      >
        <span className="text-ink-dim">{expanded ? "▾" : "▸"}</span>
        <span className="flex-1 truncate">{item.command}</span>
        {item.running ? (
          <span className="shrink-0 text-warn">running…</span>
        ) : (
          <span className={`shrink-0 ${failed ? "text-danger" : "text-ok"}`}>
            exit {item.exitCode ?? "?"}
          </span>
        )}
      </button>
      {item.cwd && <div className="mt-1 truncate text-xs text-ink-dim">{item.cwd}</div>}
      {expanded && output && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-bg p-2 text-xs text-ink-dim">
          {output}
        </pre>
      )}
    </div>
  );
}
