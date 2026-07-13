// Capture-real-first: dump raw @anthropic-ai/claude-agent-sdk messages to JSONL fixtures so the
// ClaudeMapper is built against ground truth (mirrors adapter-codex's turn-notifications.jsonl).
// Run: node packages/adapter-claude/scripts/capture.mjs   (needs `claude` on PATH + logged in)
// Model pinned to haiku, tiny prompts, settingSources:[] to isolate from the operator's config.
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "..", "test", "fixtures");
const CWD = join(__dir, "..", "..", "..", ".tmp-claude-capture");
const HOME = process.env.HOME ?? "";

mkdirSync(OUT, { recursive: true });
mkdirSync(CWD, { recursive: true });

function redactValue(v) {
  const s = JSON.stringify(v);
  const red = (HOME ? s.split(HOME).join("$HOME") : s).replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-<RED>");
  const msg = JSON.parse(red);
  // system/init leaks the operator's tool list + MCP-connector names + local paths. This repo is
  // public; strip the identifying fields (the mapper never reads them) so fixtures are safe to commit.
  if (msg && msg.type === "system" && msg.subtype === "init") {
    for (const k of ["tools", "mcp_servers", "slash_commands", "skills", "plugins", "agents"]) {
      if (Array.isArray(msg[k])) msg[k] = [];
    }
    if (typeof msg.cwd === "string") msg.cwd = "/repo";
  }
  if (typeof msg?.cwd === "string") msg.cwd = "/repo";
  return msg;
}

async function captureStringPrompt() {
  const msgs = [];
  const q = query({
    prompt:
      "Run exactly this shell command with the Bash tool: echo agentdeck-capture-ok. Then reply with just: DONE.",
    options: {
      model: "haiku",
      cwd: CWD,
      maxTurns: 4,
      settingSources: [],
      includePartialMessages: true,
      permissionMode: "default",
      canUseTool: async (toolName, input) => {
        process.stdout.write(`  [basic] canUseTool(${toolName}) -> allow\n`);
        return { behavior: "allow", updatedInput: input };
      },
    },
  });
  for await (const msg of q) msgs.push(redactValue(msg));
  const p = join(OUT, "turn-basic.jsonl");
  writeFileSync(p, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  process.stdout.write(`wrote ${p} (${msgs.length} messages)\n`);
  return msgs;
}

// A push-queue async iterable — the exact shape a live adapter uses for streaming input mode
// (sendMessage pushes here; the queue stays open so interrupt()/setPermissionMode() are available).
function inputQueue() {
  const pending = [];
  const waiters = [];
  let closed = false;
  return {
    push(text) {
      const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      if (waiters.length) waiters.shift()({ value: msg, done: false });
      else pending.push(msg);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

async function captureStreaming() {
  const msgs = [];
  const input = inputQueue();
  let denies = 0;
  const q = query({
    prompt: input,
    options: {
      model: "haiku",
      cwd: CWD,
      maxTurns: 8,
      settingSources: [],
      includePartialMessages: false,
      permissionMode: "default",
      canUseTool: async (toolName, inputArgs) => {
        // First tool call: deny (verify the unverified deny path). Later: allow.
        if (denies === 0) {
          denies++;
          process.stdout.write(`  [stream] canUseTool(${toolName}) -> DENY\n`);
          return { behavior: "deny", message: "Denied by capture harness for testing." };
        }
        process.stdout.write(`  [stream] canUseTool(${toolName}) -> allow\n`);
        return { behavior: "allow", updatedInput: inputArgs };
      },
    },
  });

  // Drive turns by pushing onto the queue as the stream settles. We push turn 1 immediately,
  // then push turn 2 after the first `result`, then close after the second `result`.
  let results = 0;
  input.push("Use the Bash tool to run: echo first-turn. Then reply DONE.");
  const consume = (async () => {
    for await (const msg of q) {
      msgs.push(redactValue(msg));
      if (msg.type === "result") {
        results++;
        if (results === 1) input.push("Now reply with just the word: pineapple. Do not use any tools.");
        else if (results >= 2) input.close();
      }
    }
  })();
  await consume;
  const p = join(OUT, "turn-streaming.jsonl");
  writeFileSync(p, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  process.stdout.write(`wrote ${p} (${msgs.length} messages, denies=${denies})\n`);
  return msgs;
}

async function main() {
  process.stdout.write("=== capture 1: string prompt (tool + allow, partial messages) ===\n");
  await captureStringPrompt();
  process.stdout.write("=== capture 2: streaming input (multi-turn, deny then allow) ===\n");
  await captureStreaming();
  if (existsSync(CWD)) rmSync(CWD, { recursive: true, force: true });
  process.stdout.write("done.\n");
}

main().catch((err) => {
  if (existsSync(CWD)) rmSync(CWD, { recursive: true, force: true });
  process.stderr.write(`capture failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
