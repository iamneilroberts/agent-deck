import { useSessionDiff } from "../../api/queries";
import { parseDiffLines, type DiffLineKind } from "./diffLines";

const LINE_STYLE: Record<DiffLineKind, string> = {
  add: "bg-ok/10 text-ok",
  remove: "bg-danger/10 text-danger",
  hunk: "text-accent",
  meta: "text-ink-dim",
  context: "text-ink-dim",
};

export function DiffView({ sessionId, path }: { sessionId: string; path?: string }) {
  const diffQuery = useSessionDiff(sessionId, path);

  if (diffQuery.isLoading) {
    return <div className="px-3 py-8 text-center text-sm text-ink-dim">Loading diff…</div>;
  }
  if (diffQuery.isError) {
    return <div className="px-3 py-8 text-center text-sm text-danger">Failed to load diff.</div>;
  }

  const diff = diffQuery.data?.diff ?? "";
  if (!diff) {
    return <div className="px-3 py-8 text-center text-sm text-ink-dim">No changes.</div>;
  }

  const lines = parseDiffLines(diff);
  return (
    <pre data-testid="diff-view" className="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-xs">
      {lines.map((line, i) => (
        <div key={i} data-testid={`diff-line-${line.kind}`} className={`px-1 ${LINE_STYLE[line.kind]}`}>
          {line.text.length > 0 ? line.text : " "}
        </div>
      ))}
    </pre>
  );
}
