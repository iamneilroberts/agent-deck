import { describe, it, expect } from "vitest";
import { LineBuffer, classify } from "../src/framing.js";

describe("LineBuffer", () => {
  it("splits multiple objects arriving in one chunk", () => {
    const b = new LineBuffer();
    const lines = b.push('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(b.pending).toBe("");
  });

  it("retains a partial line across chunks", () => {
    const b = new LineBuffer();
    expect(b.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(b.pending).toBe('{"b":');
    expect(b.push("2}\n")).toEqual(['{"b":2}']);
  });

  it("tolerates CRLF and skips blank lines", () => {
    const b = new LineBuffer();
    expect(b.push('{"a":1}\r\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("returns nothing until a newline arrives", () => {
    const b = new LineBuffer();
    expect(b.push('{"partial":')).toEqual([]);
  });
});

describe("classify (dual ID-space routing)", () => {
  it("treats id+method as a server-initiated request (approvals)", () => {
    expect(classify({ id: 0, method: "item/commandExecution/requestApproval", params: {} })).toBe(
      "serverRequest",
    );
  });

  it("treats id without method as a response to our request", () => {
    expect(classify({ id: 2, result: { thread: { id: "x" } } })).toBe("response");
    expect(classify({ id: 2, error: { message: "boom" } })).toBe("response");
  });

  it("treats method without id as a notification", () => {
    expect(classify({ method: "turn/completed", params: {} })).toBe("notification");
  });

  it("does not confuse a server request id:0 with a missing id", () => {
    // id:0 is falsy — the classifier must still see it as present.
    expect(classify({ id: 0, method: "x", params: {} })).toBe("serverRequest");
  });

  it("flags structurally unknown messages", () => {
    expect(classify({ params: {} })).toBe("unknown");
    expect(classify(null)).toBe("unknown");
    expect(classify("nope")).toBe("unknown");
  });
});
