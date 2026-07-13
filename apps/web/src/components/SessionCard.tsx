import type { AgentSession } from "@agentdeck/shared";
import { StatusBadge } from "./StatusBadge";

function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const RESUMABLE: ReadonlySet<AgentSession["status"]> = new Set(["completed", "failed", "stopped"]);

export function SessionCard({
  session,
  projectName,
  onOpen,
  onResume,
}: {
  session: AgentSession;
  projectName: string;
  onOpen: () => void;
  onResume: () => void;
}) {
  const needsApproval = session.status === "waiting_for_approval";
  const resumable = RESUMABLE.has(session.status);

  return (
    <div
      data-testid="session-card"
      className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-3 text-left"
    >
      <button type="button" onClick={onOpen} className="flex flex-col gap-1.5 text-left">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs uppercase text-ink-dim">
              {session.agentKind}
            </span>
            <span className="truncate">{session.title ?? session.workingDirectory}</span>
          </div>
          {needsApproval && (
            <span
              data-testid="approval-badge"
              className="shrink-0 rounded-full bg-warn px-2 py-0.5 text-xs font-semibold text-black"
            >
              Approval
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-dim">
          <span className="truncate">{projectName}</span>
          {session.branch && <span className="truncate">· {session.branch}</span>}
        </div>
        <div className="flex items-center justify-between">
          <StatusBadge status={session.status} />
          <span className="text-xs text-ink-dim">{relativeTime(session.updatedAt)}</span>
        </div>
      </button>
      {resumable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResume();
          }}
          data-testid="resume-button"
          className="self-start rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent"
        >
          Resume
        </button>
      )}
    </div>
  );
}
