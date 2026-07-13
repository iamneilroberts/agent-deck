// Public surface of @agentdeck/adapter-claude — the real Claude adapter, driving `claude` headless
// via @anthropic-ai/claude-agent-sdk behind the vendor-neutral AgentAdapter interface (Phase 4).
export { ClaudeTransport } from "./transport.js";
export type {
  ClaudeTransportLike,
  ClaudeTransportOptions,
  ClaudeQueryParams,
  QueryFn,
  MessageListener,
  ExitListener,
  Unsub,
} from "./transport.js";
export { ClaudeMapper } from "./mapping.js";
export type { ClaudeEventDraft } from "./mapping.js";
export { ClaudeApprovalBridge } from "./approvals-bridge.js";
export type { EmitDraft, CanUseToolContext } from "./approvals-bridge.js";
export { ClaudeAdapter } from "./claude-adapter.js";
export type { ClaudeAdapterOptions } from "./claude-adapter.js";
