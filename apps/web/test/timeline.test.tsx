import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Timeline } from "../src/components/timeline/Timeline";
import { buildTimeline } from "../src/components/timeline/buildTimeline";
import {
  approvalRequested,
  artifactCreated,
  assistantDelta,
  assistantFinal,
  commandCompleted,
  commandOutput,
  commandStarted,
  errorEvent,
  fileChanged,
  reasoningDelta,
  sessionStarted,
  testResult,
  userMessage,
} from "./fixtures/events";

function renderTimeline(events: Parameters<typeof buildTimeline>[0]) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Timeline events={events} sessionId="session-1" />
    </QueryClientProvider>,
  );
}

describe("buildTimeline", () => {
  it("concatenates assistant deltas by itemId and replaces with the final text", () => {
    const events = [
      assistantDelta(1, "item-1", "Hel"),
      assistantDelta(2, "item-1", "lo "),
      assistantFinal(3, "item-1", "Hello world"),
    ];
    const items = buildTimeline(events);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant_message", text: "Hello world", complete: true });
  });

  it("keeps separate itemIds as separate items", () => {
    const events = [assistantDelta(1, "a", "one"), assistantDelta(2, "b", "two")];
    expect(buildTimeline(events)).toHaveLength(2);
  });

  it("collapses command_started/output/completed into one item by commandId", () => {
    const events = [
      commandStarted(1, "cmd-1", "npm test"),
      commandOutput(2, "cmd-1", "ok\n"),
      commandOutput(3, "cmd-1", "done\n"),
      commandCompleted(4, "cmd-1", 0),
    ];
    const items = buildTimeline(events);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({
      kind: "command",
      command: "npm test",
      exitCode: 0,
      running: false,
    });
    if (item?.kind === "command") {
      expect(item.output.map((o) => o.chunk).join("")).toBe("ok\ndone\n");
    }
  });
});

describe("Timeline rendering", () => {
  it("renders a distinct card per event type", () => {
    const events = [
      userMessage(1, "please fix the bug"),
      assistantFinal(2, "item-1", "sure"),
      reasoningDelta(3, "r-1", "thinking…"),
      commandStarted(4, "cmd-1", "npm test"),
      commandCompleted(5, "cmd-1", 0),
      fileChanged(6, "src/index.ts"),
      approvalRequested(7, "req-1"),
      testResult(8, 5, 1),
      artifactCreated(9, "/tmp/screenshot.png"),
      errorEvent(10, "something broke"),
      sessionStarted(11),
    ];

    renderTimeline(events);

    expect(screen.getByTestId("timeline-item-user_message")).toHaveTextContent("please fix the bug");
    expect(screen.getByTestId("timeline-item-assistant_message")).toHaveTextContent("sure");
    expect(screen.getByTestId("timeline-item-reasoning")).toHaveTextContent("thinking");
    expect(screen.getByTestId("timeline-item-command")).toHaveTextContent("npm test");
    expect(screen.getByTestId("timeline-item-file_changed")).toHaveTextContent("src/index.ts");
    expect(screen.getByTestId("timeline-item-approval_requested")).toHaveTextContent("Approval needed");
    expect(screen.getByTestId("timeline-item-test_result")).toHaveTextContent("5 passed, 1 failed");
    expect(screen.getByTestId("timeline-item-artifact_created")).toHaveTextContent("screenshot.png");
    expect(screen.getByTestId("timeline-item-error")).toHaveTextContent("something broke");
    expect(screen.getByTestId("timeline-item-session_started")).toBeInTheDocument();
  });

  it("shows the running state before command_completed arrives", () => {
    renderTimeline([commandStarted(1, "cmd-1", "npm run build")]);
    expect(within(screen.getByTestId("timeline-item-command")).getByText("running…")).toBeInTheDocument();
  });
});
