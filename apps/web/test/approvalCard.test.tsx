import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApprovalCard } from "../src/components/ApprovalCard";
import type { ApprovalItem } from "../src/components/timeline/buildTimeline";

function renderApproval(item: ApprovalItem) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ApprovalCard item={item} sessionId="session-1" />
    </QueryClientProvider>,
  );
}

const item: ApprovalItem = {
  kind: "approval_requested",
  id: "evt-1",
  timestamp: new Date().toISOString(),
  request: {
    requestId: "req-1",
    kind: "command",
    summary: "Run `rm -rf build`",
    options: [
      { id: "accept", label: "Approve", kind: "allow" },
      { id: "accept-session", label: "Always allow", kind: "allow_always" },
      { id: "deny", label: "Deny", kind: "deny" },
    ],
  },
};

describe("ApprovalCard", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders exactly one button per offered option, never a hardcoded set", () => {
    renderApproval(item);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("POSTs the chosen optionId to /api/approvals/:requestId/resolve", async () => {
    const user = userEvent.setup();
    renderApproval(item);

    await user.click(screen.getByRole("button", { name: "Always allow" }));

    expect(fetch).toHaveBeenCalledWith(
      "/api/approvals/req-1/resolve",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((call?.[1]?.body as string) ?? "{}");
    expect(body).toEqual({ sessionId: "session-1", optionId: "accept-session" });
  });

  it("disables the buttons after a decision is sent", async () => {
    const user = userEvent.setup();
    renderApproval(item);
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });
});
