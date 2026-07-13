// Wire types for the /api/events WebSocket, per docs/api-contract.md. Validated with the same
// AgentEventSchema the server and the rest of the shared model use.
import { z } from "zod";
import { AgentEventSchema } from "@agentdeck/shared";

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello_ok"), sessionId: z.string(), headSequence: z.number().int() }),
  z.object({ type: z.literal("event"), event: AgentEventSchema }),
  z.object({ type: z.literal("replay_complete"), headSequence: z.number().int() }),
  z.object({ type: z.literal("heartbeat"), ts: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type ClientMessage =
  | { type: "hello"; sessionId: string; lastSeq: number }
  | { type: "ping" };

export function parseServerMessage(raw: string): ServerMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = ServerMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}
