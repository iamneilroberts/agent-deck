import { describe, it, expect } from "vitest";
import { CodexTransport } from "../src/transport.js";
import type { ExitInfo } from "../src/transport.js";

// These exercise the Phase-2 additions (design §8.5) against a real short-lived child process that
// does NOT speak the protocol — enough to prove crash handling without depending on `codex`.
const NODE = process.execPath;

/** A transport whose "app-server" is a node one-liner that exits on its own after `ms`. */
function crashingTransport(script: string) {
  return new CodexTransport({ command: NODE, args: ["-e", script] });
}

describe("CodexTransport crash handling (onExit + pending rejection)", () => {
  it("fires onExit with the exit code and rejects in-flight requests on crash", async () => {
    const t = crashingTransport("setTimeout(() => process.exit(7), 30)");
    const exit = new Promise<ExitInfo>((resolve) => t.onExit(resolve));
    await t.start();

    const req = t.request("thread/start", {});
    const info = await exit;
    expect(info.code).toBe(7);
    await expect(req).rejects.toThrow(/exited \(code=7/);
  });

  it("fires onExit only once and stops after the process is gone", async () => {
    const t = crashingTransport("setTimeout(() => process.exit(0), 20)");
    let calls = 0;
    t.onExit(() => {
      calls++;
    });
    await t.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(1);
    // A request after termination rejects immediately (transport not running), never writes.
    await expect(t.request("x")).rejects.toThrow(/not running/);
  });

  it("unsubscribing before termination suppresses the exit listener", async () => {
    const t = crashingTransport("setTimeout(() => process.exit(0), 20)");
    let called = false;
    const off = t.onExit(() => {
      called = true;
    });
    off();
    await t.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(called).toBe(false);
  });

  it("reports a spawn failure through onExit", async () => {
    const t = new CodexTransport({ command: "definitely-not-a-real-binary-xyz", args: [] });
    const exit = new Promise<ExitInfo>((resolve) => t.onExit(resolve));
    await t.start();
    const info = await exit;
    expect(info.error).toBeInstanceOf(Error);
    expect(info.error?.message).toMatch(/spawn error/);
  });
});
