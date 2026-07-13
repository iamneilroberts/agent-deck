// Phase 0 Spike B — drive Claude Code headless via the official Agent SDK.
//
// Validates the Claude side of ADR-0001 against the REAL `claude` CLI (v2.1.207) + SDK:
//   1. Structured streaming (system/init with session_id, assistant, tool_use, tool_result,
//      result) — the analogue of Codex's thread/turn stream.
//   2. Programmatic approvals via `canUseTool` — the control-protocol `can_use_tool` callback,
//      replacing the REMOVED `--permission-prompt-tool` flag. Faithful pass-through: we log the
//      tool + input and return an allow/deny decision (mirrors Codex approval handling).
//   3. Session resume via `options.resume = <session_id>` — the recovery primitive (Codex's
//      thread/resume analogue).
//
// Cost note: this spends the Claude subscription/weekly limit (unlike the Codex spikes). It is
// pinned to `haiku` with tiny prompts and `maxTurns` capped. `settingSources: []` isolates the
// run from the operator's global hooks/CLAUDE.md so the capture is clean and reproducible.
//
// Run: npm run spike   (needs `claude` on PATH + logged in)

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dir = dirname(fileURLToPath(import.meta.url));
const CAPTURED = join(__dir, "..", "captured");
const REPO_CWD = join(__dir, "..", "..", "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const MARKER = join(REPO_CWD, ".agentdeck-spikeb-marker");
const HOME = process.env.HOME ?? "";

const summary: string[] = [];
function log(line: string): void {
  summary.push(line);
  process.stdout.write(line + "\n");
}
function redact(s: string): string {
  let out = s.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-<REDACTED>");
  if (HOME) out = out.split(HOME).join("$HOME");
  return out;
}

const baseOptions = {
  model: "haiku",
  cwd: REPO_CWD,
  maxTurns: 4,
  // Isolate from the operator's global hooks/CLAUDE.md/skills so the capture is clean.
  settingSources: [] as [],
} as const;

/** Run one query to completion; return the session_id and whether canUseTool fired. */
async function runQuery(
  label: string,
  prompt: string,
  opts: { resume?: string } = {},
): Promise<{ sessionId: string | null; approvals: number; finalText: string }> {
  let sessionId: string | null = null;
  let approvals = 0;
  let finalText = "";

  const q = query({
    prompt,
    options: {
      ...baseOptions,
      ...(opts.resume ? { resume: opts.resume } : {}),
      permissionMode: "default",
      // Programmatic approval: the control-protocol can_use_tool callback.
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        approvals++;
        const brief = JSON.stringify(input).slice(0, 120);
        log(`  ▸ [${label}] canUseTool(${toolName}) input=${brief} -> allow`);
        return { behavior: "allow" as const, updatedInput: input };
      },
    },
  });

  for await (const msg of q) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          sessionId = msg.session_id;
          log(`  [${label}] init: session_id=${sessionId} model=${msg.model} tools=${msg.tools.length}`);
        }
        break;
      case "assistant": {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) finalText = block.text.trim();
          if (block.type === "tool_use") log(`  · [${label}] tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 80)}`);
        }
        break;
      }
      case "user": {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block && (block as { type?: string }).type === "tool_result") {
              const tr = block as { content?: unknown };
              log(`  · [${label}] tool_result ${JSON.stringify(tr.content).slice(0, 80)}`);
            }
          }
        }
        break;
      }
      case "result": {
        const r = msg as { subtype: string; result?: string; total_cost_usd?: number; num_turns?: number };
        log(`  [${label}] result subtype=${r.subtype} turns=${r.num_turns} cost=$${r.total_cost_usd?.toFixed(4)}`);
        break;
      }
      default:
        break;
    }
  }
  return { sessionId, approvals, finalText };
}

async function main(): Promise<void> {
  if (existsSync(MARKER)) rmSync(MARKER);
  log(`=== Spike B: Claude headless via Agent SDK (model=haiku, isolated settings) ===`);

  // 1) A turn that uses a tool -> canUseTool fires (approval round-trip).
  log(`\nquery 1: trigger a Bash tool (approval via canUseTool)...`);
  const q1 = await runQuery(
    "q1",
    "Run exactly this shell command with the Bash tool: touch .agentdeck-spikeb-marker && echo spikeb-ok. Then reply with just: DONE.",
  );
  log(`  q1 done: session=${q1.sessionId} approvals=${q1.approvals} finalText=${JSON.stringify(q1.finalText.slice(0, 40))}`);
  log(`  marker created on disk: ${existsSync(MARKER)}`);

  // 2) Resume that session and prove context continuity.
  if (q1.sessionId) {
    log(`\nquery 2: resume session ${q1.sessionId} and test recall...`);
    const q2 = await runQuery(
      "q2",
      "In your previous turn you ran an echo command. What exact word did it print? Reply with just that word.",
      { resume: q1.sessionId },
    );
    const recalled = q2.finalText.includes("spikeb-ok");
    log(`  q2 recall finalText=${JSON.stringify(q2.finalText.slice(0, 60))}`);
    log(`  CONTEXT SURVIVED RESUME: ${recalled}`);
  } else {
    log(`  (no session_id captured — cannot test resume)`);
  }

  if (existsSync(MARKER)) rmSync(MARKER);
  writeCapture();
  log(`\nSUMMARY: canUseTool approvals worked=${q1.approvals > 0}; resume tested=${q1.sessionId !== null}`);
}

function writeCapture(): void {
  mkdirSync(CAPTURED, { recursive: true });
  const md = [
    `# Spike B capture — ${STAMP}`,
    ``,
    `Claude Code headless via \`@anthropic-ai/claude-agent-sdk\` against real \`claude\` v2.1.207.`,
    `Model pinned to haiku; \`settingSources: []\` isolates from the operator's global config.`,
    ``,
    "```",
    ...summary.map(redact),
    "```",
    ``,
  ].join("\n");
  const p = join(CAPTURED, `spikeb-${STAMP}.md`);
  writeFileSync(p, md, "utf8");
  process.stdout.write(`\nwrote ${p}\n`);
}

main().catch((err) => {
  if (existsSync(MARKER)) rmSync(MARKER);
  process.stderr.write(`spike-b failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
