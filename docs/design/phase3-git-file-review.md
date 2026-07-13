# Phase 3 Design — Git & File Review

**Status:** proposed (design pass, pre-code). **Goal:** fill the 501 stubs `/diff` `/files`
`/artifacts` so the phone can review a session's work — changed files, the unified diff, artifacts.
**Grounded in:** README roadmap:172, architecture.md §Phase 3 (196-197) + §174 (artifacts
by-reference), the existing event model (`file_changed`/`artifact_created`), and the server's
session-route plumbing. Explore report scoped the building blocks; the endpoint shapes are a
**design gap** this doc pins.

## 1. Scope (MVP slice of the architecture's Phase 3) — CONFIRMED: "MVP + web review UI"
Architecture's full Phase 3 lists: status, changed-file list, unified diff, recent commits, safe
file viewer, artifact detection, screenshots, Playwright reports, external allowlist. That's large.
**This build delivers the three named REST endpoints + a git service + the security floor + a mobile
web "Review" view** that calls `/files` and `/diff` (changed-file list + diff viewer). It **defers**
(flagged, not silently dropped):
- artifact **byte-serving** + a static file route + path-allowlist file browser (no artifacts are
  produced yet — see §4, so serving bytes is premature);
- artifact **detection** (who emits `artifact_created` — no producer exists today).

**Web view** (`apps/web`): a Review panel for a session showing the changed-file list (from `/files`)
and, on selecting a file, its unified diff (from `/diff?path=`), plus a whole-session diff. It reuses
the existing api-client + query patterns and the app's current visual style (no new design system —
match `apps/web/src` conventions, avoid AI-slop defaults). It is ADDITIVE to the live timeline
(which already streams `file_changed`), giving an on-demand "what changed" review surface.

## 2. Data source decision
`file_changed` events carry an OPTIONAL diff and only fire on Codex `fileChange` completions — they
are not a reliable, complete picture of the working tree. **`/diff` and `/files` shell out to real
`git` in the session's `workingDirectory`** (the source of truth). `/artifacts` derives from the
`artifact_created` event stream (by-reference metadata; §4).

No new dependency: a small **`GitService`** using `node:child_process.execFile` (the pattern already
used for `codex --version`), NOT `simple-git` (aspirational in the stack, never installed). Args are
always arrays (no shell) — the injection floor (§5).

## 3. Endpoints (replace the diff/files/artifacts entries in `unrouted.ts`; keep `handoff` 501)
All follow the `GET /api/sessions/:id/events` template (session lookup → 404 if unknown; auth guard
already covers `/api/sessions/:id/*`).

### `GET /api/sessions/:id/files`
Changed files in the working tree via `git status --porcelain=v1 -z -uall`.
```
200 { workingDirectory, isGitRepo: true, branch: string|null, head: string|null,
      files: [{ path, status, staged, untracked }] }        // status = added|modified|deleted|renamed|untracked
200 { workingDirectory, isGitRepo: false, files: [] }        // not a git repo — graceful, not a 500
404 { error: "not_found" }                                   // unknown session
```

### `GET /api/sessions/:id/diff`
Unified diff of tracked changes vs HEAD via `git diff HEAD` (captures staged + unstaged). Optional
`?path=<repo-relative>` for one file.
```
200 { workingDirectory, isGitRepo: true, path?: string, diff: string }   // diff "" when no changes
200 { workingDirectory, isGitRepo: false, diff: "" }
400 { error: "invalid_path" }                                            // traversal / arg-injection (§5)
404 { error: "not_found" }
```

### `GET /api/sessions/:id/artifacts`
Derived from `artifact_created` events: `store.getEventsSince(id, 0)` filtered by type (in-memory —
no type-filtered store query exists; fine at session scale). By-reference metadata only.
```
200 { artifacts: [{ id, sequence, timestamp, artifactType, path, mimeType? }] }   // [] until a producer emits them
404 { error: "not_found" }
```
Honest today: returns `[]` for every session because no adapter emits `artifact_created` yet — the
plumbing is ready for when one does. (Byte-serving deferred, §1.)

## 4. Why `/artifacts` is plumbing-only
`artifact_created` is schema-only — grep finds no producer in adapter-codex or fake-adapter.
Building byte-serving + detection now would be speculative. `/artifacts` reads the event stream so
it lights up automatically once a producer lands (Playwright-report detection, screenshot capture —
a later phase), with zero re-plumbing. This is deliberate, not an omission.

## 5. Security floor (non-negotiable — architecture §163 allowlist intent)
- **No shell:** `execFile("git", [args...], {cwd})` — never string-interpolated, never `exec`.
- **Arg-injection guard:** a `?path=` beginning with `-` is rejected (would be read as a git flag);
  git invocations use `--` before user paths.
- **Traversal guard:** `?path=` is resolved against `workingDirectory` with `path.resolve`; if the
  result escapes the working dir (or contains `..` segments), 400 `invalid_path`. `/files` and
  `/diff` (no path) only ever run inside `workingDirectory`.
- **No file bytes served** in this MVP → no file-read traversal surface at all (the strongest
  version of the floor). When byte-serving lands later it MUST reuse this resolve-and-contain check
  plus the external allowlist.
- **Non-repo / git error** → graceful typed response (`isGitRepo:false`) or 500 with no path/stderr
  leakage, never an unhandled throw.

## 6. Server wiring
- `apps/server/src/git/git-service.ts` — `GitService` (`status`, `diff`, `isRepo`), execFile-based,
  timeouts, output-size cap. A `GitRunner` seam (default = real execFile) lets route tests inject a
  fake without a real repo; GitService's own unit tests use a REAL temp git repo.
- `apps/server/src/routes/git-review.ts` — `registerGitReviewRoutes(app, store, gitService)`.
- `server.ts` constructs one `GitService` and passes it in; `unrouted.ts` drops diff/files/artifacts
  (keeps `handoff`). No `ServerDeps` change needed (GitService constructed internally, injectable in
  tests via the route registration).

## 7. Testing
- **GitService** (real temp repo): init, add/modify/delete/untracked → assert `status` parsing;
  `diff HEAD` contains the change; non-repo dir → `isRepo:false`; single-path diff.
- **Routes** (buildServer + injected fake GitRunner + in-memory store): each endpoint's 200 shape,
  404 for unknown session, `isGitRepo:false` path, `/artifacts` filters the event stream.
- **Security**: `?path=-x`, `?path=../../etc/passwd`, `?path=/abs/outside` → 400; assert no git
  process is spawned for a rejected path.
- **DoD live check** (Opus): boot the server, real session in a real git repo with real edits →
  `/files` lists them, `/diff` returns the unified diff, `/artifacts` returns `[]`. Mirrors the
  Phase 2 live-drive style.

## 8. Build sequence (Opus locks core / Sonnet does mechanical)
1. `GitService` + `GitRunner` seam + `git status`/`diff` parsing (Opus locks parsing + security).
2. GitService unit tests vs a real temp repo (Sonnet).
3. `git-review.ts` routes + wire into `server.ts`, trim `unrouted.ts` (Opus locks the route contract).
4. Route + security tests (Sonnet).
5. DoD live check vs a real repo (Opus).

## 9. Open decisions (defaults chosen; confirm the scope call)
- **Scope**: MVP three endpoints + git service + security floor, deferring byte-serving/detection/UI
  (§1). ← the one decision worth confirming before building.
- `/diff` uses `git diff HEAD` (staged+unstaged vs last commit) — the "what changed this session"
  view. Recent-commits list deferred (not one of the three named stubs).
- In-memory event filtering for `/artifacts` (no new store method) — revisit only if it ever matters.
