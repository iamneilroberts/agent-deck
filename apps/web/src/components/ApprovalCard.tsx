// Renders an approval_requested event. Buttons come ONLY from `request.options` — never a
// hardcoded allow/deny — because the agent's own protocol is the source of truth for what
// decisions are legal (ADR-0001, docs/api-contract.md "approve validates against the pending
// ApprovalRequest").
import { useState } from "react";
import type { ApprovalOption } from "@agentdeck/shared";
import { useResolveApproval } from "../api/queries";
import type { ApprovalItem } from "./timeline/buildTimeline";

const OPTION_STYLE: Record<ApprovalOption["kind"], string> = {
  allow: "bg-ok text-black hover:bg-ok/80",
  allow_always: "bg-ok/80 text-black hover:bg-ok/60",
  deny: "bg-danger text-white hover:bg-danger/80",
  custom: "bg-surface-raised border border-border text-ink hover:bg-border",
};

export function ApprovalCard({ item, sessionId }: { item: ApprovalItem; sessionId: string }) {
  const { request } = item;
  const [chosenOptionId, setChosenOptionId] = useState<string | null>(null);
  const resolve = useResolveApproval();

  const resolved = chosenOptionId !== null;

  function choose(option: ApprovalOption) {
    if (resolved) return;
    setChosenOptionId(option.id);
    resolve.mutate({ requestId: request.requestId, sessionId, optionId: option.id });
  }

  return (
    <div
      data-testid="timeline-item-approval_requested"
      className="rounded-lg border-2 border-accent bg-accent/10 px-3 py-3 text-sm"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-accent px-1.5 py-0.5 text-xs font-semibold uppercase text-black">
          Approval needed
        </span>
        <span className="text-xs text-ink-dim">{request.kind.replace("_", " ")}</span>
      </div>
      <div className="font-medium">{request.summary}</div>
      {request.cwd && <div className="mt-0.5 text-xs text-ink-dim">{request.cwd}</div>}
      {request.reason && <div className="mt-1 text-xs text-ink-dim">{request.reason}</div>}

      <div className="mt-3 flex flex-wrap gap-2">
        {request.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={resolved || resolve.isPending}
            onClick={() => choose(option)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${OPTION_STYLE[option.kind]} ${
              chosenOptionId === option.id ? "ring-2 ring-offset-1 ring-offset-bg ring-ink" : ""
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {resolved && (
        <div className="mt-2 text-xs text-ink-dim">
          {resolve.isError ? "Failed to send decision." : "Decision sent."}
        </div>
      )}
    </div>
  );
}
