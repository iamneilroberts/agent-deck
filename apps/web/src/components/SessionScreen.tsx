import { useState } from "react";
import { useSession, useStopSession } from "../api/queries";
import { useUiStore } from "../store/uiStore";
import { useEventsClient } from "../ws/useEventsClient";
import { StatusBadge } from "./StatusBadge";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { Timeline } from "./timeline/Timeline";
import { Composer } from "./Composer";
import { ReviewPanel } from "./review/ReviewPanel";

const ACTIVE_STATUSES = new Set(["starting", "running", "waiting_for_user", "waiting_for_approval"]);

type View = "timeline" | "review";

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const sessionQuery = useSession(sessionId);
  const stopSession = useStopSession(sessionId);
  const eventsState = useEventsClient(sessionId);
  const [view, setView] = useState<View>("timeline");

  const session = sessionQuery.data?.session;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <button
          type="button"
          onClick={() => setActiveSessionId(null)}
          className="shrink-0 rounded-md px-2 py-1 text-sm text-ink-dim"
          aria-label="Back to sessions"
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs uppercase text-ink-dim">
              {session?.agentKind ?? "…"}
            </span>
            <span className="truncate">{session?.title ?? session?.workingDirectory ?? "Loading…"}</span>
          </div>
          <div className="truncate text-xs text-ink-dim">
            {session?.branch ?? session?.workingDirectory}
          </div>
        </div>
        {session && <StatusBadge status={session.status} />}
        <button
          type="button"
          onClick={() => stopSession.mutate()}
          disabled={!session || !ACTIVE_STATUSES.has(session.status) || stopSession.isPending}
          className="shrink-0 rounded-md border border-danger px-2 py-1 text-xs font-medium text-danger disabled:opacity-40"
        >
          Stop
        </button>
      </header>

      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1">
        <div className="flex gap-1">
          <TabButton label="Timeline" active={view === "timeline"} onClick={() => setView("timeline")} />
          <TabButton label="Review" active={view === "review"} onClick={() => setView("review")} />
        </div>
        <ConnectionIndicator status={eventsState.status} />
      </div>

      <main className="flex-1 overflow-y-auto">
        {view === "timeline" ? (
          <Timeline events={eventsState.events} sessionId={sessionId} />
        ) : (
          <ReviewPanel sessionId={sessionId} />
        )}
      </main>

      <Composer sessionId={sessionId} disabled={!session || session.status === "completed"} />
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-xs font-medium ${
        active ? "bg-surface-raised text-ink" : "text-ink-dim"
      }`}
    >
      {label}
    </button>
  );
}
