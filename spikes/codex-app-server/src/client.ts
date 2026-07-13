// Typed convenience layer over CodexTransport for the v2 thread/turn API.
// This is intentionally thin — it is NOT the eventual AgentDeck adapter, just enough typed
// surface to demonstrate the lifecycle in the spike.

import { CodexTransport, type CodexTransportOptions } from "./transport.js";
import type {
  InitializeParams,
  InitializeResponse,
  ThreadStartParams,
  ThreadStartResult,
  TurnStartParams,
  TurnInterruptParams,
  ThreadResumeParams,
  ThreadListParams,
  WireServerNotification,
} from "./proto.js";

export class CodexClient {
  readonly transport: CodexTransport;

  constructor(opts: CodexTransportOptions = {}) {
    this.transport = new CodexTransport(opts);
  }

  start(): Promise<void> {
    return this.transport.start();
  }
  close(): Promise<void> {
    return this.transport.close();
  }
  onNotification(l: (n: WireServerNotification) => void): () => void {
    return this.transport.onNotification(l);
  }

  async initialize(clientName = "agentdeck-spike", version = "0.0.0"): Promise<InitializeResponse> {
    const params: InitializeParams = {
      clientInfo: { name: clientName, title: "AgentDeck Spike", version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    const res = await this.transport.request<InitializeResponse>("initialize", params);
    this.transport.notify("initialized");
    return res;
  }

  threadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
    return this.transport.request<ThreadStartResult>("thread/start", params);
  }

  turnStart(params: TurnStartParams): Promise<unknown> {
    return this.transport.request("turn/start", params);
  }

  turnInterrupt(params: TurnInterruptParams): Promise<unknown> {
    return this.transport.request("turn/interrupt", params);
  }

  threadResume(params: ThreadResumeParams): Promise<unknown> {
    return this.transport.request("thread/resume", params);
  }

  threadList(params: ThreadListParams = {}): Promise<{ data: Array<{ id: string; cwd: string; preview?: string }>; nextCursor: string | null }> {
    return this.transport.request("thread/list", params);
  }
}

/** Convenience: send a plain-text user turn. */
export function textInput(text: string): TurnStartParams["input"] {
  return [{ type: "text", text, text_elements: [] }];
}
