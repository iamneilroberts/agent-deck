// Public surface of @agentdeck/adapter-codex. The `CodexAdapter` (implementing AgentAdapter) lands
// in a later Phase-2 step; step 1 exports the lifted transport layer + protocol types.
export { CodexTransport } from "./transport.js";
export type {
  TransportLike,
  CodexTransportOptions,
  NotificationListener,
  ServerRequestHandler,
  ExitInfo,
  ExitListener,
  RawLogger,
} from "./transport.js";
export { LineBuffer, classify } from "./framing.js";
export type { WireKind } from "./framing.js";
export * from "./proto.js";
