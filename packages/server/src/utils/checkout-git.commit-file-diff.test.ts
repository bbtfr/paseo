import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getCommitFileDiff, listCheckoutCommits } from "./checkout-git.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "commit-file-diff-test-")));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd }).toString();
}

function commitFile(repoDir: string, name: string, content: string, message: string): void {
  writeFileSync(join(repoDir, name), content);
  git(["add", "."], repoDir);
  git(["-c", "commit.gpgsign=false", "commit", "-m", message], repoDir);
}

function initRepo(): string {
  const tempDir = makeTempDir();
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "test@test.com"], repoDir);
  git(["config", "user.name", "Test User"], repoDir);
  return repoDir;
}

function headSha(repoDir: string): string {
  return git(["rev-parse", "HEAD"], repoDir).trim();
}

describe("getCommitFileDiff", () => {
  it.each([
    { edited: false, name: "new.txt" },
    { edited: true, name: "new.txt" },
    { edited: false, name: 'new "draft".txt' },
    { edited: true, name: "目录.txt" },
  ])("preserves a committed rename ($name, edited: $edited)", async ({ edited, name }) => {
    const repoDir = initRepo();
    commitFile(repoDir, "old.txt", "same\nkeep\nlast\n", "initial");
    git(["mv", "old.txt", name], repoDir);
    if (edited) writeFileSync(join(repoDir, name), "same\nKEEP\nlast\n");
    git(["add", "."], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "rename"], repoDir);
    const sha = headSha(repoDir);

    const history = await listCheckoutCommits({ cwd: repoDir });
    expect(history.commits.find((commit) => commit.sha === sha)?.files).toEqual([
      { path: name, status: "renamed", additions: edited ? 1 : 0, deletions: edited ? 1 : 0 },
    ]);
    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: name });
    expect(file).toMatchObject({
      path: name,
      isNew: false,
      isDeleted: false,
      additions: edited ? 1 : 0,
      deletions: edited ? 1 : 0,
    });
    if (!edited) expect(file?.hunks).toEqual([]);
    else {
      expect(file?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "remove", content: "keep" }),
          expect.objectContaining({ type: "add", content: "KEEP" }),
        ]),
      );
    }
  });

  it("returns the parsed diff for a modified file in a commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "a\nb\nc\n", "initial");
    commitFile(repoDir, "foo.txt", "a\nB\nc\nd\n", "edit foo");
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "foo.txt" });

    expect(file).not.toBeNull();
    expect(file?.path).toBe("foo.txt");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks.length).toBeGreaterThan(0);

    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines.some((line) => line.type === "add" && line.content === "B")).toBe(true);
    expect(lines.some((line) => line.type === "add" && line.content === "d")).toBe(true);
    expect(lines.some((line) => line.type === "remove" && line.content === "b")).toBe(true);
  });

  it("returns a diff flagged as new for an added file", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "README.md", "base\n", "initial");
    commitFile(repoDir, "added.txt", "x\ny\n", "add file");
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "added.txt" });

    expect(file?.path).toBe("added.txt");
    expect(file?.isNew).toBe(true);
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
  });

  it("returns null for a path not changed in the commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "a\n", "initial");
    commitFile(repoDir, "foo.txt", "a\nb\n", "edit foo");
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "does-not-exist.txt" });

    expect(file).toBeNull();
  });

  it("does not follow an unchanged file back to an earlier commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "same\n", "initial");
    commitFile(repoDir, "other.txt", "other\n", "unrelated change");
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "foo.txt" }),
    ).toBeNull();
  });

  it("returns the added file in a root commit and the deleted file in its deletion commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "same\n", "initial");
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "foo.txt" }),
    ).toMatchObject({
      isNew: true,
      isDeleted: false,
      additions: 1,
      deletions: 0,
    });
    git(["rm", "foo.txt"], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "delete"], repoDir);
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "foo.txt" }),
    ).toMatchObject({
      isNew: false,
      isDeleted: true,
      additions: 0,
      deletions: 1,
    });
  });

  it("preserves a rename introduced by a merge against its first parent", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "old.txt", "same\n", "initial");
    git(["checkout", "-b", "feature"], repoDir);
    git(["mv", "old.txt", "new.txt"], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "rename"], repoDir);
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "main.txt", "main\n", "advance main");
    git(["merge", "--no-ff", "feature", "-m", "merge feature"], repoDir);
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "new.txt" }),
    ).toMatchObject({
      path: "new.txt",
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  it("returns a merge commit diff against its first parent", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "README.md", "base\n", "initial");
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "add feature");
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "main.txt", "main\n", "advance main");
    git(["merge", "--no-ff", "feature", "-m", "merge feature"], repoDir);
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "feature.txt" });

    expect(file?.path).toBe("feature.txt");
    expect(file?.isNew).toBe(true);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(0);
  });
});
