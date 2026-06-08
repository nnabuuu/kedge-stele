// Tests for src/paths.ts — the .stele/ marker walk-up.
//
// paths.ts reads process.cwd() and process.env.HOME at call time, so we
// chdir + flip HOME per test. Each test gets a fresh tmp dir tree.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDbPath, SteleNotInitializedError } from "./paths.ts";

let savedCwd: string;
let savedHome: string | undefined;
let savedSteleDb: string | undefined;
let savedProvDb: string | undefined;
let tmpHome: string;

beforeEach(() => {
  savedCwd = process.cwd();
  savedHome = process.env.HOME;
  savedSteleDb = process.env.STELE_DB;
  savedProvDb = process.env.PROV_DB;
  delete process.env.STELE_DB;
  delete process.env.PROV_DB;
  // On macOS tmpdir() returns /var/folders/... which is a symlink to
  // /private/var/folders/... — chdir resolves symlinks, so we canonicalize
  // up-front to match what process.cwd() will report.
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "stele-paths-test-")));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  // Restore working directory FIRST so cleanup of tmpHome can succeed
  try { process.chdir(savedCwd); } catch { /* ignore */ }
  rmSync(tmpHome, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (savedSteleDb !== undefined) process.env.STELE_DB = savedSteleDb;
  else delete process.env.STELE_DB;
  if (savedProvDb !== undefined) process.env.PROV_DB = savedProvDb;
  else delete process.env.PROV_DB;
});

// ---- STELE_DB override --------------------------------------------------

test("STELE_DB wins over walk-up", () => {
  process.env.STELE_DB = "/override/path/decisions.db";
  // Even with no .stele/ anywhere, override returns directly
  assert.equal(resolveDbPath(), "/override/path/decisions.db");
});

test("PROV_DB is honoured as a legacy alias", () => {
  process.env.PROV_DB = "/legacy/path/decisions.db";
  assert.equal(resolveDbPath(), "/legacy/path/decisions.db");
});

test("STELE_DB takes precedence over PROV_DB", () => {
  process.env.STELE_DB = "/new/decisions.db";
  process.env.PROV_DB = "/old/decisions.db";
  assert.equal(resolveDbPath(), "/new/decisions.db");
});

// ---- Walk-up at cwd ----------------------------------------------------

test("returns DB path when .stele/ is at cwd", () => {
  const project = join(tmpHome, "project");
  mkdirSync(join(project, ".stele"), { recursive: true });
  process.chdir(project);
  assert.equal(resolveDbPath(), join(project, ".stele", "decisions.db"));
});

test("returns DB path when .stele/ is at an ancestor", () => {
  const project = join(tmpHome, "project");
  const sub = join(project, "src", "deep");
  mkdirSync(join(project, ".stele"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  process.chdir(sub);
  assert.equal(resolveDbPath(), join(project, ".stele", "decisions.db"));
});

// ---- $HOME boundary ----------------------------------------------------

test("walk-up STOPS at $HOME (does NOT pick up $HOME/.stele/ from a subdir)", () => {
  // Create $HOME/.stele/ and a subdirectory that has no .stele/ of its own
  mkdirSync(join(tmpHome, ".stele"), { recursive: true });
  const sub = join(tmpHome, "projects", "foo");
  mkdirSync(sub, { recursive: true });
  process.chdir(sub);

  // We're at $HOME/projects/foo — walk up should hit $HOME and stop,
  // NOT pick up the $HOME/.stele/ that exists.
  assert.throws(() => resolveDbPath(), SteleNotInitializedError);
});

test("if cwd IS $HOME and $HOME/.stele exists, it IS picked up (explicit global)", () => {
  mkdirSync(join(tmpHome, ".stele"), { recursive: true });
  process.chdir(tmpHome);
  assert.equal(resolveDbPath(), join(tmpHome, ".stele", "decisions.db"));
});

// ---- Not-initialized -----------------------------------------------------

test("throws SteleNotInitializedError when no .stele/ anywhere", () => {
  const project = join(tmpHome, "project");
  mkdirSync(project, { recursive: true });
  process.chdir(project);
  assert.throws(() => resolveDbPath(), SteleNotInitializedError);
});

test("the error message mentions the cwd and `stele init`", () => {
  const project = join(tmpHome, "no-init-here");
  mkdirSync(project, { recursive: true });
  process.chdir(project);
  try {
    resolveDbPath();
    assert.fail("expected throw");
  } catch (e) {
    const err = e as Error;
    assert.ok(err.message.includes("stele init"));
    // Mac /tmp resolves through /private/tmp; check basename match instead
    assert.ok(err.message.includes("no-init-here") || err.message.includes(project));
  }
});

// ---- Edge: cwd has .stele/ that's a FILE not a directory --------------

test("a .stele FILE (not directory) is NOT treated as a marker", () => {
  const project = join(tmpHome, "weird");
  mkdirSync(project, { recursive: true });
  // Create a FILE named .stele in the project root
  writeFileSync(join(project, ".stele"), "this is a file, not a dir");
  process.chdir(project);

  // Walk-up should reject this and either find an ancestor's .stele/ or throw.
  // In our setup, the only ancestor with anything is $HOME (no .stele).
  assert.throws(() => resolveDbPath(), SteleNotInitializedError);
});
