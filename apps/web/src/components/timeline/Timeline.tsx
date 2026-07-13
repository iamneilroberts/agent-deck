import type { AgentEvent } from "@agentdeck/shared";
import { buildTimeline } from "./buildTimeline";
import { MessageCard } from "./cards/MessageCard";
import { CommandCard } from "./cards/CommandCard";
import { FileChangedCard } from "./cards/FileChangedCard";
import { TestResultCard } from "./cards/TestResultCard";
import { ArtifactCard } from "./cards/ArtifactCard";
import { ErrorCard } from "./cards/ErrorCard";
import { GenericEventCard } from "./cards/GenericEventCard";
import { ApprovalCard } from "../ApprovalCard";

export function Timeline({ events, sessionId }: { events: readonly AgentEvent[]; sessionId: string }) {
  const items = buildTimeline(events);

  if (items.length === 0) {
    return <div className="px-3 py-8 text-center text-sm text-ink-dim">No activity yet.</div>;
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {items.map((item) => {
        switch (item.kind) {
          case "assistant_message":
          case "reasoning":
          case "user_message":
            return <MessageCard key={`${item.kind}:${item.id}`} item={item} />;
          case "command":
            return <CommandCard key={item.id} item={item} />;
          case "file_changed":
            return <FileChangedCard key={item.id} item={item} />;
          case "approval_requested":
            return <ApprovalCard key={item.id} item={item} sessionId={sessionId} />;
          case "test_result":
            return <TestResultCard key={item.id} item={item} />;
          case "artifact_created":
            return <ArtifactCard key={item.id} item={item} />;
          case "error":
            return <ErrorCard key={item.id} item={item} />;
          case "generic":
            return <GenericEventCard key={item.id} item={item} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
