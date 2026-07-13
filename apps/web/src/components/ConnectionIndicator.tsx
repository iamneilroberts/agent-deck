import type { ConnectionStatus } from "../ws/reducer";

const LABEL: Record<ConnectionStatus, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  replaying: "Syncing…",
  live: "Live",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
  error: "Connection error",
};

const DOT: Record<ConnectionStatus, string> = {
  idle: "bg-ink-dim",
  connecting: "bg-warn animate-pulse",
  replaying: "bg-warn animate-pulse",
  live: "bg-ok",
  reconnecting: "bg-warn animate-pulse",
  closed: "bg-ink-dim",
  error: "bg-danger",
};

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <span data-testid="connection-indicator" className="flex items-center gap-1.5 text-xs text-ink-dim">
      <span className={`h-2 w-2 rounded-full ${DOT[status]}`} />
      {LABEL[status]}
    </span>
  );
}
