# Codex app-server approval matrix (authoritative)

Source of truth for the Phase 2 adapter's `approvals-bridge.ts`. Generated + live-verified in
build step 0 against **codex-cli 0.144.1** (same version as the Phase 0 spikes — no drift).

- **Regenerate:** `codex app-server generate-ts --experimental --out <dir>` (needs `--experimental`
  for `requestUserInput` / elicitation). Reconcile this file when bumping the Codex version.
- **Two parallel approval systems exist** — the adapter uses **v2** (the thread/turn API the spikes
  drive), NOT the legacy v1:
  - **v1 (legacy, do NOT use):** `execCommandApproval` / `applyPatchApproval`, both answered with
    `{decision: ReviewDecision}` where `ReviewDecision = "approved" | "approved_for_session" |
    "denied" | "timed_out" | "abort" | {approved_execpolicy_amendment} | {network_policy_amendment}`.
  - **v2 (what we implement):** `item/*/requestApproval` + `item/tool/requestUserInput`, with the
    per-kind decision enums below.

## v2 server→client requests (from generated `ServerRequest`)

| method | params type | response type | proven |
|---|---|---|---|
| `item/commandExecution/requestApproval` | `CommandExecutionRequestApprovalParams` (**carries `availableDecisions?: CommandExecutionApprovalDecision[]`**) | `{ decision: CommandExecutionApprovalDecision }` | ✅ Spike A (accept) |
| `item/fileChange/requestApproval` | `FileChangeRequestApprovalParams` (**NO `availableDecisions`** — fixed enum) | `{ decision: FileChangeApprovalDecision }` | ✅ Spike A′ (accept) + step-0 (**decline**) |
| `item/tool/requestUserInput` | `ToolRequestUserInputParams` | `{ answers: { [questionId]: ToolRequestUserInputAnswer } }` | ⚠️ types known, **never fired live** (experimental) |
| `item/permissions/requestApproval` | `PermissionsRequestApprovalParams` | `{ permissions, scope, strictAutoReview? }` (complex `GrantedPermissionProfile`) | ❌ unproven — **stub-decline** for Phase 2 |
| `mcpServer/elicitation/request` | `McpServerElicitationRequestParams` | — | ❌ defer |
| `item/tool/call` | `DynamicToolCallParams` | — | ❌ defer |

## Decision enums (authoritative, from generated types)

```ts
// item/commandExecution/requestApproval  (a list of these arrives in availableDecisions)
type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }   // ExecPolicyAmendment = string[]
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } }
  | "decline"
  | "cancel";

// item/fileChange/requestApproval  (NO list transmitted — this fixed set IS the protocol contract)
type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
```

### fileChange params (exact, live-captured step 0)
```json
{ "threadId": "...", "turnId": "...", "itemId": "exec-...", "startedAtMs": 1783937483379,
  "reason": null, "grantRoot": null }
```
Live decline result: `{ approvalSeen: true, fileWritten: false, turnStatus: "completed" }` — the
turn completed with finalText `"Unable to create the file: the patch was rejected."` **Declining is
safe and graceful; the file is not written.**

### requestUserInput shapes (experimental — types known, not yet live)
```ts
type ToolRequestUserInputParams = { threadId, turnId, itemId,
  questions: ToolRequestUserInputQuestion[], autoResolutionMs: number | null };
type ToolRequestUserInputQuestion = { id: string, header: string, question: string,
  isOther: boolean, isSecret: boolean, options: ToolRequestUserInputOption[] | null };
type ToolRequestUserInputOption = { label: string, description: string };
// response:
type ToolRequestUserInputResponse = { answers: { [questionId: string]: { answers: string[] } } };
```
Note the answer is `{ answers: string[] }` **per question** (multi-select capable), and questions
carry `isSecret` (mask in UI) + `options`. Richer than the neutral `user_input_requested` event
models today (`prompt` + optional `questions: string[]`) — Phase 2 maps single-question best-effort;
the fuller structure is a threaded cleanup.

## Impact on the design (`phase2-codex-adapter.md`)
- **Gate (a) CLOSED:** `FileChangeApprovalDecision` is a real generated fixed enum
  (`accept | acceptForSession | decline | cancel`); `decline` is live-proven. Surfacing this fixed
  set is faithful (it IS the protocol's contract for a request that transmits no list), keyed on
  `method === "item/fileChange/requestApproval"`, cited to this file.
- **Gate (b) UPGRADED:** `requestUserInput` wire shapes are now known (not guessed) but remain
  experimental + never-fired — implement against these types, keep behind a "verify live" flag.
- The adapter's `proto.ts` subset must use the **v2** method names + these two decision enums
  (incl. the object-decision variants for command approvals: `acceptWithExecpolicyAmendment`,
  `applyNetworkPolicyAmendment`).
- `ApprovalOption.id` mapping: string decisions → the string verbatim; object decisions →
  `JSON.stringify(decision)`, round-tripped back to `{ decision: <parsedObject> }`.
