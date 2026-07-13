import type { TestResultItem } from "../buildTimeline";

export function TestResultCard({ item }: { item: TestResultItem }) {
  const allPassed = item.failed === 0;
  return (
    <div
      data-testid="timeline-item-test_result"
      className={`rounded-lg border px-3 py-2 text-sm ${
        allPassed ? "border-ok/40 bg-ok/10" : "border-danger/40 bg-danger/10"
      }`}
    >
      <span className={allPassed ? "text-ok" : "text-danger"}>
        {item.passed} passed, {item.failed} failed
      </span>
      {typeof item.total === "number" && (
        <span className="text-ink-dim"> of {item.total}</span>
      )}
      {item.summary && <div className="mt-1 text-xs text-ink-dim">{item.summary}</div>}
    </div>
  );
}
