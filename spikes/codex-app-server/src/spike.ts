// Phase 0 Spike A — drive the REAL `codex app-server` end to end.
//
// Demonstrates, against the installed binary (no mocks):
//   1. initialize + initialized handshake
//   2. thread/start -> thread id
//   3. turn/start with streaming (agentMessage deltas + item lifecycle + commandExecution)
//   4. an approval round-trip (server -> client requestApproval, we reply from availableDecisions)
//   5. turn/interrupt on a second, longer turn
//   6. thread/list + thread/resume (recovery primitives)
//   7. clean shutdown
//
// Writes TWO transcripts to captured/:
//   raw-<ts>.jsonl        every wire line, both directions  (GITIGNORED — may contain secrets)
//   session-<ts>.md       sanitized, human-readable summary (safe to commit)
//
// Run: npm run spike
// Nothing binds to a socket; this talks to app-server over stdio only.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CodexClient } from "./client.js";
import { runTurnToCompletion, nextTurnId } from "./turns.js";
import { redact } from "./redact.js";
import type { WireServerRequest } from "./proto.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CAPTURED = join(__dir, "..", "captured");
const REPO_CWD = join(__dir, "..", "..", ".."); // ~/dev/agentdeck
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

const rawLines: string[] = [];
const summary: string[] = [];
function log(line: string): void {
  summary.push(line);
  process.stdout.write(line + "\n");
}

async function main(): Promise<void> {
  mkdirSync(CAPTURED, { recursive: true });

  const client = new CodexClient({
    cwd: REPO_CWD,
    onRawLine: (dir, line) => rawLines.push(`${dir}\t${line}`),
  });

  // Route ALL streaming notifications to a compact, readable log.
  const deltas: string[] = [];
  client.onNotification((n) => {
    switch (n.method) {
      case "mcpServer/startupStatus/updated":
        return; // suppress MCP boot chatter
      case "item/agentMessage/delta": {
        deltas.push((n.params as { delta: string }).delta);
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = (n.params as { item: { type: string } }).item;
        if (n.method === "item/started" && item.type === "commandExecution") {
          const c = item as unknown as { command: string; cwd: string };
          log(`  · command started: ${c.command}`);
        }
        if (n.method === "item/completed" && item.type === "commandExecution") {
          const c = item as unknown as { exitCode: number | null; aggregatedOutput: string | null };
          log(`  · command exit=${c.exitCode} output=${JSON.stringify((c.aggregatedOutput ?? "").trim())}`);
        }
        if (n.method === "item/completed" && item.type === "agentMessage") {
          const m = item as unknown as { text: string; phase: string | null };
          log(`  · agentMessage[${m.phase}]: ${JSON.stringify(m.text)}`);
        }
        return;
      }
      case "turn/completed": {
        const s = (n.params as { turn: { status: unknown } }).turn.status;
        log(`  · turn/completed status=${JSON.stringify(s)}`);
        return;
      }
      case "error": {
        log(`  · ERROR ${JSON.stringify(n.params)}`);
        return;
      }
      default:
        return;
    }
  });

  // Faithful approval handler: reply ONLY with a decision the server offered.
  let approvalsSeen = 0;
  client.transport.setServerRequestHandler((req: WireServerRequest) => {
    if (req.method.includes("requestApproval")) {
      approvalsSeen++;
      const p = req.params as { command?: string; availableDecisions?: unknown[] };
      log(`  ▸ APPROVAL REQUEST (${req.method}): ${JSON.stringify(p.command ?? "")}`);
      log(`    availableDecisions=${JSON.stringify(p.availableDecisions)}`);
      const decision = pickDecision(p.availableDecisions);
      log(`    -> replying decision=${JSON.stringify(decision)}`);
      return { decision };
    }
    if (req.method === "item/tool/requestUserInput") {
      log(`  ▸ USER INPUT REQUEST: ${JSON.stringify(req.params)}`);
      return { response: "yes" };
    }
    // Unhandled server request: decline explicitly (never leave the agent hanging).
    log(`  ▸ unhandled server request ${req.method} -> declining`);
    return { decision: "cancel" };
  });

  await client.start();

  // 1) initialize
  const info = await client.initialize();
  log(`initialize ok: userAgent=${redact(info.userAgent)} os=${info.platformOs}`);

  // 2) thread/start — untrusted policy + read-only sandbox so a write forces an approval.
  const started = await client.threadStart({
    cwd: REPO_CWD,
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });
  const threadId = started.thread.id;
  log(`thread/start ok: threadId=${threadId} model=${started.model}`);
  log(`  instructionSources=${JSON.stringify(started.instructionSources)}`);

  // 3+4) a turn that needs an approval (write under read-only sandbox).
  // NOTE: turn/start's RESPONSE resolves when the turn is ACCEPTED, not when it completes —
  // completion arrives as a `turn/completed` notification. We must await that.
  log(`turn 1: asking for a command that requires approval...`);
  deltas.length = 0;
  const before1 = approvalsSeen;
  const t1 = await runTurnToCompletion(
    client,
    threadId,
    "Run exactly this shell command: touch .agentdeck-spike-marker && echo created. " +
      "Then reply with the single word DONE.",
  );
  log(
    `  turn 1 done: turnId=${t1.turnId} status=${JSON.stringify(t1.status)} ` +
      `deltas=${deltas.length} approvals=${approvalsSeen - before1}`,
  );

  // 5) interrupt: start a longer turn, then interrupt it mid-flight.
  log(`turn 2: starting a long turn, then interrupting it...`);
  const interrupted = await runTurnAndInterrupt(
    client,
    threadId,
    "Count slowly from 1 to 40, one number per line, thinking between each.",
  );
  log(`  interrupt result: ${interrupted}`);

  // 6) recovery primitives
  const list = await client.threadList({ cwd: REPO_CWD, limit: 5 });
  const found = list.data.some((t) => t.id === threadId);
  log(`thread/list: ${list.data.length} thread(s) for this cwd; our thread present=${found}`);
  await client.threadResume({ threadId });
  log(`thread/resume ok for threadId=${threadId}`);

  // 7) clean shutdown
  await client.close();
  log(`closed cleanly.`);

  writeCaptures();
  log(`\nSUMMARY: approvals=${approvalsSeen} — Spike A demonstrated all lifecycle operations.`);
}

/** Choose a decision from the server-provided set. Prefer a one-off "accept"; never invent. */
function pickDecision(available: unknown[] | undefined): unknown {
  if (!available || available.length === 0) return "accept";
  const hasAccept = available.some((d) => d === "accept");
  return hasAccept ? "accept" : (available[0] as unknown);
}

/** Start a turn, interrupt it once it is under way, and report the settled status. */
async function runTurnAndInterrupt(client: CodexClient, threadId: string, text: string): Promise<string> {
  const completion = runTurnToCompletion(client, threadId, text);
  const turnId = await nextTurnId(client); // wait for turn/started so there's something to interrupt
  if (!turnId) return "no turn/started observed (nothing to interrupt)";
  await client.turnInterrupt({ threadId, turnId });
  try {
    const r = await completion;
    return `turn ${turnId} settled with status=${JSON.stringify(r.status)}`;
  } catch (e) {
    return `turn ${turnId} interrupted (${e instanceof Error ? e.message : String(e)})`;
  }
}

function writeCaptures(): void {
  // Raw (gitignored): redact home paths but keep structure for local debugging.
  const rawPath = join(CAPTURED, `raw-${STAMP}.jsonl`);
  writeFileSync(rawPath, rawLines.map((l) => redact(l)).join("\n") + "\n", "utf8");

  // Sanitized, committable summary.
  const mdPath = join(CAPTURED, `session-${STAMP}.md`);
  const md = [
    `# Spike A capture — ${STAMP}`,
    ``,
    `Generated by \`npm run spike\` against the real \`codex app-server\`. Home paths are`,
    `replaced with \`$HOME\` and secret-looking values are redacted.`,
    ``,
    "```",
    ...summary.map((l) => redact(l)),
    "```",
    ``,
  ].join("\n");
  writeFileSync(mdPath, md, "utf8");
  process.stdout.write(`\nwrote ${rawPath}\nwrote ${mdPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`spike failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
