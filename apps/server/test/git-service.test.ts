import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService, parseStatus, resolveRepoPath } from "../src/git/git-service.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A repo with one committed file, then a modified/untracked/deleted working-tree state. */
function makeDirtyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-review-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "root"]);
  writeFileSync(join(dir, "tracked.txt"), "original\n");
  writeFileSync(join(dir, "to-delete.txt"), "bye\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "seed files"]);

  // Now dirty the working tree: modify tracked, add untracked, delete a tracked file.
  writeFileSync(join(dir, "tracked.txt"), "original\nchanged line\n");
  writeFileSync(join(dir, "new-file.txt"), "hello\n");
  unlinkSync(join(dir, "to-delete.txt"));
  return dir;
}

describe("GitService (real repo, execGitRunner)", () => {
  let dirtyRepo: string;
  let plainDir: string;

  beforeEach(() => {
    dirtyRepo = makeDirtyRepo();
    plainDir = mkdtempSync(join(tmpdir(), "git-review-nonrepo-"));
  });

  afterEach(() => {
    rmSync(dirtyRepo, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });

  it("isRepo is true for a real repo and false for a plain directory", async () => {
    const svc = new GitService();
    expect(await svc.isRepo(dirtyRepo)).toBe(true);
    expect(await svc.isRepo(plainDir)).toBe(false);
  });

  it("status() reports modified/untracked/deleted files with correct flags", async () => {
    const svc = new GitService();
    const result = await svc.status(dirtyRepo);

    expect(result.isGitRepo).toBe(true);
    expect(result.branch).not.toBeNull();
    expect(result.head).not.toBeNull();

    const byPath = new Map(result.files.map((f) => [f.path, f]));
    // Neither tracked.txt nor to-delete.txt was `git add`ed after the working-tree edit, so both
    // are unstaged changes (X column blank).
    expect(byPath.get("tracked.txt")).toMatchObject({ status: "modified", staged: false, untracked: false });
    expect(byPath.get("new-file.txt")).toMatchObject({ status: "untracked", staged: false, untracked: true });
    expect(byPath.get("to-delete.txt")).toMatchObject({ status: "deleted", staged: false, untracked: false });
    expect(result.files).toHaveLength(3);
  });

  it("status() marks a staged (git add'ed) change as staged:true", async () => {
    git(dirtyRepo, ["add", "tracked.txt"]);
    const svc = new GitService();
    const result = await svc.status(dirtyRepo);
    const tracked = result.files.find((f) => f.path === "tracked.txt");
    expect(tracked).toMatchObject({ status: "modified", staged: true, untracked: false });
  });

  it("status() on a non-repo directory returns isGitRepo:false and no files", async () => {
    const svc = new GitService();
    const result = await svc.status(plainDir);
    expect(result).toEqual({ isGitRepo: false, branch: null, head: null, files: [] });
  });

  it("diff() returns a unified diff containing the modified file and the changed line", async () => {
    const svc = new GitService();
    const result = await svc.diff(dirtyRepo);
    expect(result.isGitRepo).toBe(true);
    expect(result.diff).toContain("tracked.txt");
    expect(result.diff).toContain("changed line");
  });

  it("diff() scoped to a single path only contains that file", async () => {
    const svc = new GitService();
    const result = await svc.diff(dirtyRepo, "tracked.txt");
    expect(result.path).toBe("tracked.txt");
    expect(result.diff).toContain("tracked.txt");
    expect(result.diff).not.toContain("new-file.txt");
    expect(result.diff).not.toContain("to-delete.txt");
  });

  it("diff() on a fresh repo with no commits yet does not throw", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "git-review-fresh-"));
    try {
      git(freshDir, ["init", "-q"]);
      writeFileSync(join(freshDir, "untracked.txt"), "content\n");
      const svc = new GitService();
      const result = await svc.diff(freshDir);
      expect(result.isGitRepo).toBe(true);
      expect(typeof result.diff).toBe("string");
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe("parseStatus (pure)", () => {
  it("parses a modified tracked file", () => {
    const raw = " M file.txt\0";
    expect(parseStatus(raw)).toEqual([
      { path: "file.txt", status: "modified", staged: false, untracked: false },
    ]);
  });

  it("parses a staged-added file", () => {
    const raw = "A  file.txt\0";
    expect(parseStatus(raw)).toEqual([
      { path: "file.txt", status: "added", staged: true, untracked: false },
    ]);
  });

  it("parses an untracked file (?? marker)", () => {
    const raw = "?? f\0";
    expect(parseStatus(raw)).toEqual([{ path: "f", status: "untracked", staged: false, untracked: true }]);
  });

  it("parses a rename entry, skipping the origin path token", () => {
    const raw = "R  new\0old\0";
    const files = parseStatus(raw);
    expect(files).toEqual([{ path: "new", status: "renamed", staged: true, untracked: false }]);
  });

  it("parses a deleted tracked file", () => {
    const raw = " D file.txt\0";
    expect(parseStatus(raw)).toEqual([
      { path: "file.txt", status: "deleted", staged: false, untracked: false },
    ]);
  });

  it("handles empty input", () => {
    expect(parseStatus("")).toEqual([]);
  });
});

describe("resolveRepoPath (pure)", () => {
  const cwd = "/repo/root";

  it("returns a relative path for a normal in-repo path", () => {
    expect(resolveRepoPath(cwd, "file.txt")).toBe("file.txt");
  });

  it("returns a valid relative path for a nested path", () => {
    expect(resolveRepoPath(cwd, "sub/file.ts")).toBe("sub/file.ts");
  });

  it("rejects a leading-dash path (would be read as a git flag)", () => {
    expect(resolveRepoPath(cwd, "-x")).toBeNull();
  });

  it("rejects a path that traverses outside cwd", () => {
    expect(resolveRepoPath(cwd, "../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute path outside cwd", () => {
    expect(resolveRepoPath(cwd, "/etc/passwd")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(resolveRepoPath(cwd, "")).toBeNull();
  });

  it("rejects a path containing a NUL byte", () => {
    expect(resolveRepoPath(cwd, "file\0.txt")).toBeNull();
  });

  it("rejects the repo root itself", () => {
    expect(resolveRepoPath(cwd, ".")).toBeNull();
  });
});
