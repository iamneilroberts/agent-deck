// Phase 0 Spike A' — de-risk the two things Spike A left uncertain, both load-bearing for
// Phase 2 (recovery) and Phase 5 (cross-agent handoff, where a second agent process is the
// whole point):
//
//   PART 1  Fuller approval matrix — trigger and answer item/fileChange/requestApproval
//           (Spike A already covered item/commandExecution/requestApproval).
//   PART 2  Cross-process RECOVERY — process A establishes context and exits; a FRESH
//           app-server process B resumes the thread, reads its history, and continues a turn
//           that depends on the earlier context (proves continuity survives a restart).
//   PART 3  Concurrent ATTACH — while process A holds a thread active, a second live process B
//           tries to resume/read the same thread. Records the observed behavior (rejoin vs
//           independent load vs error) — the exact question Spike A flagged as unknown.
//
// Run: npm run spike:aprime   (needs `codex` on PATH + logged in). stdio only, no sockets.

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
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
const MARKER = join(REPO_CWD, ".agentdeck-aprime-marker.md");

const summary: string[] = [];
function log(line: string): void {
  summary.push(line);
  process.stdout.write(line + "\n");
}

/** Approval handler that records each approval kind and answers from availableDecisions. */
function attachApprovalHandler(client: CodexClient, seen: Record<string, number>): void {
  client.transport.setServerRequestHandler((req: WireServerRequest) => {
    const kind = req.method;
    seen[kind] = (seen[kind] ?? 0) + 1;
    const p = req.params as { command?: string; availableDecisions?: unknown[]; questions?: unknown[] };
    if (kind.includes("requestApproval")) {
      const decision = pickDecision(p.availableDecisions);
      log(`  ▸ ${kind} decisions=${JSON.stringify(p.availableDecisions ?? "(none given)")} -> ${JSON.stringify(decision)}`);
      return { decision };
    }
    if (kind === "item/tool/requestUserInput") {
      log(`  ▸ ${kind} questions=${JSON.stringify(p.questions)} -> answering "yes"`);
      // Best-effort: answer every question id with "yes".
      const answers: Record<string, unknown> = {};
      for (const q of (p.questions ?? []) as Array<{ id?: string }>) if (q.id) answers[q.id] = { text: "yes" };
      return { answers };
    }
    log(`  ▸ ${kind} (unhandled) -> declining`);
    return { decision: "cancel" };
  });
}

/** Prefer a one-off accept from whatever the server offered; never invent a decision. */
function pickDecision(available: unknown[] | undefined): unknown {
  if (!available || available.length === 0) return "accept"; // fileChange sends no list; accept is valid
  return available.some((d) => d === "accept") ? "accept" : (available[0] as unknown);
}

async function part1_approvalMatrix(): Promise<Record<string, number>> {
  log(`\n=== PART 1: approval matrix (fileChange) ===`);
  if (existsSync(MARKER)) rmSync(MARKER);
  const client = new CodexClient({ cwd: REPO_CWD });
  const seen: Record<string, number> = {};
  attachApprovalHandler(client, seen);
  await client.start();
  await client.initialize("agentdeck-aprime-p1");
  const started = await client.threadStart({ cwd: REPO_CWD, approvalPolicy: "on-request", sandbox: "read-only" });
  const threadId = started.thread.id;
  log(`  thread ${threadId} started (on-request / read-only)`);

  // Ask for an apply_patch style file edit (not a shell write) to elicit fileChange approval.
  const r = await runTurnToCompletion(
    client,
    threadId,
    "Using your file-editing/apply_patch tool (NOT a shell command), create a new file " +
      "`.agentdeck-aprime-marker.md` containing exactly the text `spike-aprime`. Then reply DONE.",
  );
  log(`  turn status=${JSON.stringify(r.status)} finalText=${JSON.stringify(r.finalText.slice(0, 40))}`);
  log(`  approval kinds seen: ${JSON.stringify(seen)}`);
  log(`  marker file created on disk: ${existsSync(MARKER)}`);
  await client.close();
  return seen;
}

async function part2_crossProcessRecovery(): Promise<void> {
  log(`\n=== PART 2: cross-process recovery (restart) ===`);
  const codeword = "BANANA-42";

  // Process A: establish context, then exit.
  const a = new CodexClient({ cwd: REPO_CWD });
  attachApprovalHandler(a, {});
  await a.start();
  await a.initialize("agentdeck-aprime-p2a");
  const started = await a.threadStart({ cwd: REPO_CWD, approvalPolicy: "on-request", sandbox: "read-only" });
  const threadId = started.thread.id;
  const r1 = await runTurnToCompletion(
    a,
    threadId,
    `Remember this codeword for later: ${codeword}. Just reply "noted" — do not run any tools.`,
  );
  log(`  [proc A] thread ${threadId} established context; status=${JSON.stringify(r1.status)}`);
  await a.close();
  log(`  [proc A] closed (simulating an AgentDeck restart)`);

  // Process B: FRESH app-server, resume the thread and continue.
  const b = new CodexClient({ cwd: REPO_CWD });
  attachApprovalHandler(b, {});
  await b.start();
  await b.initialize("agentdeck-aprime-p2b");
  await b.threadResume({ threadId });
  const read = await b.threadRead(threadId, true);
  const turnCount = read.thread.turns?.length ?? 0;
  log(`  [proc B] resumed thread; thread/read includeTurns -> ${turnCount} turn(s) in history`);
  const r2 = await runTurnToCompletion(
    b,
    threadId,
    "What was the codeword I asked you to remember earlier? Reply with just the codeword.",
  );
  const recalled = r2.finalText.includes(codeword);
  log(`  [proc B] recall turn finalText=${JSON.stringify(r2.finalText.slice(0, 60))}`);
  log(`  [proc B] CONTEXT SURVIVED RESTART: ${recalled}`);
  await b.close();
}

async function part3_concurrentAttach(): Promise<void> {
  log(`\n=== PART 3: concurrent attach (two live processes) ===`);
  const a = new CodexClient({ cwd: REPO_CWD });
  attachApprovalHandler(a, {});
  await a.start();
  await a.initialize("agentdeck-aprime-p3a");
  const started = await a.threadStart({ cwd: REPO_CWD, approvalPolicy: "on-request", sandbox: "read-only" });
  const threadId = started.thread.id;

  // Start a long turn in A and keep it running.
  const aTurn = runTurnToCompletion(a, threadId, "Count slowly from 1 to 40, one number per line.");
  const aTurnId = await nextTurnId(a);
  log(`  [proc A] long turn ${aTurnId} running on thread ${threadId}`);

  // While A's turn runs, a SECOND live process tries to resume + read the same thread.
  const b = new CodexClient({ cwd: REPO_CWD });
  attachApprovalHandler(b, {});
  await b.start();
  await b.initialize("agentdeck-aprime-p3b");
  let resumeOutcome: string;
  try {
    await b.threadResume({ threadId });
    const read = await b.threadRead(threadId, true);
    resumeOutcome = `resume+read OK while A active (turns visible=${read.thread.turns?.length ?? 0})`;
  } catch (e) {
    resumeOutcome = `resume/read REJECTED while A active: ${e instanceof Error ? e.message : String(e)}`;
  }
  log(`  [proc B] ${resumeOutcome}`);
  await b.close();

  // Clean up A's running turn.
  if (aTurnId) await a.turnInterrupt({ threadId, turnId: aTurnId });
  try {
    const r = await aTurn;
    log(`  [proc A] long turn settled status=${JSON.stringify(r.status)}`);
  } catch (e) {
    log(`  [proc A] long turn ended: ${e instanceof Error ? e.message : String(e)}`);
  }
  await a.close();
}

function writeCapture(): void {
  mkdirSync(CAPTURED, { recursive: true });
  const md = [
    `# Spike A' capture — ${STAMP}`,
    ``,
    `Cross-process recovery + approval matrix, driven against the real \`codex app-server\`.`,
    `Home paths are replaced with \`$HOME\`; secret-looking values are redacted.`,
    ``,
    "```",
    ...summary.map((l) => redact(l)),
    "```",
    ``,
  ].join("\n");
  const mdPath = join(CAPTURED, `aprime-${STAMP}.md`);
  writeFileSync(mdPath, md, "utf8");
  process.stdout.write(`\nwrote ${mdPath}\n`);
}

async function main(): Promise<void> {
  const matrix = await part1_approvalMatrix();
  await part2_crossProcessRecovery();
  await part3_concurrentAttach();
  if (existsSync(MARKER)) rmSync(MARKER); // clean up the file the agent created
  writeCapture();
  log(`\nSUMMARY: fileChange approval seen=${(matrix["item/fileChange/requestApproval"] ?? 0) > 0}`);
}

main().catch((err) => {
  if (existsSync(MARKER)) rmSync(MARKER);
  process.stderr.write(`spike-aprime failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
