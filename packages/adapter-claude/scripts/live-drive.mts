// Live-drive the REAL ClaudeAdapter against the REAL `claude` CLI (Opus live-drive step, Phase 4).
// No fakes: uses the real ClaudeTransport -> query() -> claude. Proves the DoD end-to-end:
//   start a session, stream assistant output, run a tool with an approval round-trip, complete,
//   send a follow-up turn, capture the vendor session id, then resume it and prove context recall.
// Spends real Claude quota (pinned to haiku, tiny prompts). Run: npx tsx scripts/live-drive.mts
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@agentdeck/shared";
import { ClaudeAdapter } from "../src/claude-adapter.js";

const CWD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".tmp-live-drive");
const MODEL = "haiku";
const log = (s: string) => process.stdout.write(s + "\n");

function summarize(e: AgentEvent): string {
  switch (e.type) {
    case "session_started": return `session_started ext=${e.externalSessionId} model=${e.model}`;
    case "session_status_changed": return `status -> ${e.status}`;
    case "user_message": return `user: ${e.text}`;
    case "assistant_message": return `assistant: ${JSON.stringify(e.text).slice(0, 60)}`;
    case "reasoning": return `reasoning: ${e.text.slice(0, 40)}...`;
    case "tool_started": return `tool_started ${e.toolName} ${JSON.stringify(e.input).slice(0, 50)}`;
    case "tool_output": return `tool_output ok=${e.ok} ${JSON.stringify(e.output).slice(0, 40)}`;
    case "approval_requested": return `APPROVAL kind=${e.request.kind} "${e.request.summary}" opts=[${e.request.options.map((o) => o.id).join(",")}]`;
    case "error": return `error: ${e.message}`;
    default: return e.type;
  }
}

async function waitFor(pred: () => boolean, ms = 60000, label = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  if (existsSync(CWD)) rmSync(CWD, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });

  const adapter = new ClaudeAdapter();
  const install = await adapter.detectInstallation();
  log(`detectInstallation: ${JSON.stringify(install)}`);
  if (!install.installed) throw new Error("claude not installed");

  const events: AgentEvent[] = [];
  const sessionId = randomUUID();
  let approvedRequestIds = new Set<string>();

  adapter.subscribe(sessionId, (e) => {
    events.push(e);
    log(`  · ${summarize(e)}`);
    // Auto-approve any approval request that surfaces (the "phone taps Allow" moment).
    if (e.type === "approval_requested" && !approvedRequestIds.has(e.request.requestId)) {
      approvedRequestIds.add(e.request.requestId);
      const allow = e.request.options.find((o) => o.kind === "allow");
      if (allow) {
        log(`  >> approving ${e.request.requestId} with "${allow.id}"`);
        void adapter.approve(sessionId, { requestId: e.request.requestId, optionId: allow.id });
      }
    }
  });

  // === Turn 1: trigger a Bash tool (write) so canUseTool fires -> approval round-trip. ===
  log("\n=== turn 1: start session + Bash tool (approval) ===");
  const handle = await adapter.startSession({
    sessionId,
    workingDirectory: CWD,
    model: MODEL,
    prompt: "Run this with the Bash tool: mkdir -p sub && echo live-ok > sub/marker.txt. Then reply with just: DONE.",
  });
  log(`startSession handle: ${JSON.stringify(handle)}`);
  await waitFor(() => events.some((e) => e.type === "session_status_changed" && e.status === "completed"), 90000, "turn 1 completed");

  const externalId = events.find((e) => e.type === "session_started")?.type === "session_started"
    ? (events.find((e) => e.type === "session_started") as Extract<AgentEvent, { type: "session_started" }>).externalSessionId
    : undefined;
  const sawApproval = events.some((e) => e.type === "approval_requested");
  const sawTool = events.some((e) => e.type === "tool_started");
  log(`\nturn 1: externalId=${externalId} approvalSeen=${sawApproval} toolSeen=${sawTool} markerOnDisk=${existsSync(join(CWD, "sub", "marker.txt"))}`);

  // === Turn 2: follow-up on the same live session. ===
  log("\n=== turn 2: follow-up message (same session) ===");
  const before = events.length;
  await adapter.sendMessage(sessionId, "Reply with just the word: pineapple. Do not use any tools.");
  await waitFor(() => events.slice(before).filter((e) => e.type === "session_status_changed" && e.status === "completed").length >= 1, 60000, "turn 2 completed");
  const turn2Text = events.slice(before).filter((e) => e.type === "assistant_message").map((e) => (e as { text: string }).text).join(" ");
  log(`turn 2 assistant text: ${JSON.stringify(turn2Text)}`);

  await adapter.stop(sessionId);
  log(`stopped. status trail: ${events.filter((e) => e.type === "session_status_changed").map((e) => (e as { status: string }).status).join(" -> ")}`);

  // === Resume: prove a stopped session's id can be resumed with context recall. ===
  if (externalId) {
    log("\n=== resume: new session resuming the vendor id, recall test ===");
    const rid = randomUUID();
    const rEvents: AgentEvent[] = [];
    adapter.subscribe(rid, (e) => { rEvents.push(e); log(`  · ${summarize(e)}`); });
    await adapter.resumeSession({
      sessionId: rid,
      externalSessionId: externalId,
      workingDirectory: CWD,
      prompt: "In an earlier turn you wrote a word into sub/marker.txt via echo. What exact word was it? Reply with just that word.",
    });
    await waitFor(() => rEvents.some((e) => e.type === "session_status_changed" && e.status === "completed"), 60000, "resume completed");
    const recallText = rEvents.filter((e) => e.type === "assistant_message").map((e) => (e as { text: string }).text).join(" ");
    log(`resume recall text: ${JSON.stringify(recallText)}`);
    log(`CONTEXT SURVIVED RESUME: ${recallText.includes("live-ok")}`);
    await adapter.stop(rid);
  }

  await adapter.shutdown();
  if (existsSync(CWD)) rmSync(CWD, { recursive: true, force: true });
  log("\n=== DONE ===");
}

main().catch((err) => {
  if (existsSync(CWD)) rmSync(CWD, { recursive: true, force: true });
  process.stderr.write(`live-drive failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
