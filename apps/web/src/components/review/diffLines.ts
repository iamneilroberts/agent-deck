// Pure line classifier for a raw unified-diff string, so DiffView can color lines without
// pulling in a diff-parsing library. Mirrors the timeline's buildTimeline.ts split: parsing
// logic lives here (unit-testable), rendering lives in the component.
export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export function parseDiffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  return diff.split("\n").map((text) => ({ kind: classify(text), text }));
}

function classify(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode")
  ) {
    return "meta";
  }
  return "context";
}
