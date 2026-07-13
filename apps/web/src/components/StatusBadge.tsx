import type { SessionStatus } from "@agentdeck/shared";

const STYLE: Record<SessionStatus, string> = {
  starting: "bg-ink-dim/20 text-ink-dim",
  running: "bg-accent/20 text-accent",
  waiting_for_user: "bg-warn/20 text-warn",
  waiting_for_approval: "bg-warn/20 text-warn",
  paused: "bg-ink-dim/20 text-ink-dim",
  completed: "bg-ok/20 text-ok",
  failed: "bg-danger/20 text-danger",
  stopped: "bg-ink-dim/20 text-ink-dim",
};

const LABEL: Record<SessionStatus, string> = {
  starting: "Starting",
  running: "Running",
  waiting_for_user: "Needs input",
  waiting_for_approval: "Needs approval",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span
      data-testid="status-badge"
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STYLE[status]}`}
    >
      {LABEL[status]}
    </span>
  );
}
