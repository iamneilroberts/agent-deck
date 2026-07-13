import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReviewPanel } from "../src/components/review/ReviewPanel";
import { parseDiffLines } from "../src/components/review/diffLines";

function renderReviewPanel() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ReviewPanel sessionId="session-1" />
    </QueryClientProvider>,
  );
}

const FILES_RESPONSE = {
  workingDirectory: "/repo",
  isGitRepo: true,
  branch: "main",
  head: "abcdef1234567890",
  files: [{ path: "src/index.ts", status: "modified", staged: false, untracked: false }],
};

const DIFF_RESPONSE = {
  workingDirectory: "/repo",
  isGitRepo: true,
  diff: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context line\n",
};

describe("ReviewPanel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files")) {
          return new Response(JSON.stringify(FILES_RESPONSE), { status: 200 });
        }
        if (url.includes("/diff")) {
          return new Response(JSON.stringify(DIFF_RESPONSE), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists a modified file with its status badge", async () => {
    renderReviewPanel();
    expect(await screen.findByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByTestId("review-file-row")).toHaveTextContent("M");
  });

  it("renders the diff with added lines colored distinctly from removed lines", async () => {
    renderReviewPanel();
    await waitFor(() => expect(screen.getByTestId("diff-view")).toBeInTheDocument());
    const addLine = screen.getByText("+new line");
    const removeLine = screen.getByText("-old line");
    expect(addLine.className).toContain("text-ok");
    expect(removeLine.className).toContain("text-danger");
    expect(addLine.className).not.toBe(removeLine.className);
  });

  it("shows 'Not a git repository' when isGitRepo is false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ workingDirectory: "/repo", isGitRepo: false, branch: null, head: null, files: [] }), {
          status: 200,
        }),
      ),
    );
    renderReviewPanel();
    expect(await screen.findByText("Not a git repository.")).toBeInTheDocument();
  });
});

describe("parseDiffLines", () => {
  it("classifies +/- content lines as add/remove and leaves headers as meta/hunk", () => {
    const lines = parseDiffLines(DIFF_RESPONSE.diff);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(["meta", "meta", "meta", "hunk", "remove", "add", "context", "context"]);
  });
});
