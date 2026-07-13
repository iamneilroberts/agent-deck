// Read-only git access for the Phase 3 review endpoints (design phase3-git-file-review.md).
// Shells out to `git` with execFile (args as an ARRAY — never a shell string), scoped to a
// session's workingDirectory. No `simple-git` dependency. The `GitRunner` seam lets route tests
// inject a fake; GitService's own tests use a real temp repo.
import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}
/** Runs a git invocation in `cwd`. Never throws for a non-zero exit — reports it via `code`. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** Staged in the index (X column set, not untracked). */
  staged: boolean;
  untracked: boolean;
}

export interface StatusResult {
  isGitRepo: boolean;
  branch: string | null;
  head: string | null;
  files: ChangedFile[];
}

export interface DiffResult {
  isGitRepo: boolean;
  path?: string;
  diff: string;
}

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024; // cap output so a huge diff can't exhaust memory

/** Default runner: execFile, no shell. A non-zero exit resolves (with `code`) rather than throwing. */
export const execGitRunner: GitRunner = (args, cwd) =>
  new Promise<GitRunResult>((resolveRun) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolveRun({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });

/**
 * Validate a caller-supplied repo-relative path against `cwd` — the traversal/arg-injection floor
 * (design §5). Returns the safe relative path, or null if it must be rejected (route → 400).
 */
export function resolveRepoPath(cwd: string, rawPath: string): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  if (rawPath.startsWith("-")) return null; // would be read as a git flag
  if (rawPath.includes("\0")) return null;
  const abs = resolve(cwd, rawPath);
  const root = resolve(cwd);
  if (abs !== root && !abs.startsWith(root + sep)) return null; // escaped the working dir
  const rel = abs.slice(root.length + 1);
  return rel.length > 0 ? rel : null; // the repo root itself isn't a file path for a diff
}

export class GitService {
  constructor(private readonly run: GitRunner = execGitRunner) {}

  async isRepo(cwd: string): Promise<boolean> {
    const r = await this.run(["rev-parse", "--is-inside-work-tree"], cwd);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async status(cwd: string): Promise<StatusResult> {
    if (!(await this.isRepo(cwd))) return { isGitRepo: false, branch: null, head: null, files: [] };
    const [branchR, headR, statusR] = await Promise.all([
      this.run(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
      this.run(["rev-parse", "HEAD"], cwd),
      this.run(["status", "--porcelain=v1", "-z", "-uall"], cwd),
    ]);
    return {
      isGitRepo: true,
      branch: branchR.code === 0 ? branchR.stdout.trim() || null : null,
      head: headR.code === 0 ? headR.stdout.trim() || null : null,
      files: parseStatus(statusR.stdout),
    };
  }

  /** Unified diff of tracked changes vs HEAD (staged + unstaged). `safePath` must be pre-validated
   *  by `resolveRepoPath`. When the repo has no commits yet, diffs the worktree vs the index. */
  async diff(cwd: string, safePath?: string): Promise<DiffResult> {
    if (!(await this.isRepo(cwd))) return { isGitRepo: false, diff: "" };
    const hasHead = (await this.run(["rev-parse", "--verify", "HEAD"], cwd)).code === 0;
    const base = hasHead ? ["diff", "HEAD"] : ["diff"];
    const args = safePath ? [...base, "--", safePath] : base;
    const r = await this.run(args, cwd);
    const result: DiffResult = { isGitRepo: true, diff: r.stdout };
    if (safePath) result.path = safePath;
    return result;
  }
}

/** Parse `git status --porcelain=v1 -z -uall` output into normalized changed files. Pure. */
export function parseStatus(raw: string): ChangedFile[] {
  const tokens = raw.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 3) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    if (x === "R" || x === "C") {
      // rename/copy: the following NUL-separated token is the origin path — skip it.
      i++;
    }
    const untracked = x === "?" && y === "?";
    files.push({
      path,
      status: classifyStatus(x, y, untracked),
      staged: !untracked && x !== " " && x !== "?",
      untracked,
    });
  }
  return files;
}

function classifyStatus(x: string, y: string, untracked: boolean): FileStatus {
  if (untracked) return "untracked";
  const codes = x + y;
  if (x === "R" || y === "R") return "renamed";
  if (codes.includes("A")) return "added";
  if (codes.includes("D")) return "deleted";
  return "modified";
}
