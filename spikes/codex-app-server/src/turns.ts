// Shared turn helpers. The load-bearing lesson from Spike A: a turn's completion is a
// `turn/completed` NOTIFICATION keyed by turnId — NOT the `turn/start` response (which only
// signals "accepted"). Both spikes drive turns through here so that stays correct in one place.

import type { CodexClient } from "./client.js";
import { textInput } from "./client.js";

export interface TurnResult {
  turnId: string | null;
  status: unknown;
  /** Concatenated final_answer agentMessage text streamed during the turn. */
  finalText: string;
}

/** Fire a turn and resolve when its `turn/completed` (or matching `error`) notification arrives. */
export function runTurnToCompletion(
  client: CodexClient,
  threadId: string,
  text: string,
  timeoutMs = 120_000,
): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve, reject) => {
    let turnId: string | null = null;
    let finalText = "";
    const finalItemIds = new Set<string>();

    const timeout = setTimeout(() => {
      off();
      reject(new Error(`turn did not complete within ${timeoutMs}ms`));
    }, timeoutMs);

    const off = client.onNotification((n) => {
      switch (n.method) {
        case "turn/started":
          turnId = (n.params as { turn: { id: string } }).turn.id;
          return;
        case "item/started": {
          const item = (n.params as { item: { type: string; id: string; phase?: string | null } }).item;
          if (item.type === "agentMessage" && item.phase === "final_answer") finalItemIds.add(item.id);
          return;
        }
        case "item/agentMessage/delta": {
          const p = n.params as { itemId: string; delta: string };
          if (finalItemIds.has(p.itemId)) finalText += p.delta;
          return;
        }
        case "turn/completed": {
          const p = n.params as { threadId: string; turn: { id: string; status: unknown } };
          if (p.threadId === threadId && (turnId === null || p.turn.id === turnId)) {
            clearTimeout(timeout);
            off();
            resolve({ turnId: p.turn.id, status: p.turn.status, finalText });
          }
          return;
        }
        case "error": {
          const p = n.params as { threadId: string };
          if (p.threadId === threadId) {
            clearTimeout(timeout);
            off();
            reject(new Error(`turn error: ${JSON.stringify(n.params)}`));
          }
          return;
        }
        default:
          return;
      }
    });

    client.turnStart({ threadId, input: textInput(text) }).catch(reject);
  });
}

/** Wait for the next `turn/started` and return its turnId (or null on timeout). */
export function nextTurnId(client: CodexClient, timeoutMs = 8000): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const off = client.onNotification((n) => {
      if (n.method === "turn/started") {
        off();
        resolve((n.params as { turn: { id: string } }).turn.id);
      }
    });
    setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
  });
}
