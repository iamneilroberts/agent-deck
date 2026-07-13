import { useState } from "react";
import { useSessionFiles } from "../../api/queries";
import type { ChangedFile, FileStatus } from "../../api/client";
import { DiffView } from "./DiffView";

const STATUS_LABEL: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

const STATUS_STYLE: Record<FileStatus, string> = {
  added: "text-ok",
  modified: "text-warn",
  deleted: "text-danger",
  renamed: "text-accent",
  untracked: "text-ink-dim",
};

export function ReviewPanel({ sessionId }: { sessionId: string }) {
  const filesQuery = useSessionFiles(sessionId);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);

  if (filesQuery.isLoading) {
    return <div className="px-3 py-8 text-center text-sm text-ink-dim">Loading…</div>;
  }
  if (filesQuery.isError) {
    return <div className="px-3 py-8 text-center text-sm text-danger">Failed to load changes.</div>;
  }

  const result = filesQuery.data;
  if (!result || !result.isGitRepo) {
    return <div className="px-3 py-8 text-center text-sm text-ink-dim">Not a git repository.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5 text-xs text-ink-dim">
        <span className="truncate">{result.branch ?? "detached HEAD"}</span>
        {result.head && <span className="shrink-0 font-mono">{result.head.slice(0, 7)}</span>}
      </div>

      {result.files.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-ink-dim">No changes.</div>
      ) : (
        <>
          <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-2">
            <button
              type="button"
              onClick={() => setSelectedPath(undefined)}
              className={`rounded-md px-2 py-1 text-left text-xs font-medium ${
                selectedPath === undefined ? "bg-surface-raised text-ink" : "text-ink-dim"
              }`}
            >
              Whole session diff
            </button>
            {result.files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                selected={selectedPath === file.path}
                onSelect={() => setSelectedPath(file.path)}
              />
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            <DiffView sessionId={sessionId} path={selectedPath} />
          </div>
        </>
      )}
    </div>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: ChangedFile;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="review-file-row"
      onClick={onSelect}
      className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs ${
        selected ? "bg-surface-raised text-ink" : "text-ink-dim"
      }`}
    >
      <span className={`w-3 shrink-0 font-mono font-semibold uppercase ${STATUS_STYLE[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>
      <span className="truncate font-mono">{file.path}</span>
    </button>
  );
}
