// Tests for src/registry.ts — slugify, uniquification, register/unregister.
//
// Each test gets a fresh tmp HOME so the real ~/.stele/registry.json is
// never touched. registry.ts calls os.homedir() at function-call time, so
// flipping HOME between tests is enough — no module reloads needed.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allProjects,
  findByPath,
  findBySlug,
  loadRegistry,
  register,
  registryPath,
  saveRegistry,
  slugify,
  unregister,
} from "./registry.ts";

let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "stele-registry-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
});

// ---- slugify --------------------------------------------------------------

test("slugify lowercases", () => {
  assert.equal(slugify("FooBar"), "foobar");
});

test("slugify replaces non-alphanum with hyphens", () => {
  assert.equal(slugify("w@ird name!"), "w-ird-name");
});

test("slugify collapses multiple hyphens", () => {
  assert.equal(slugify("a___b   c"), "a-b-c");
});

test("slugify trims leading/trailing hyphens", () => {
  assert.equal(slugify("---hello---"), "hello");
});

test("slugify falls back to 'project' for empty input", () => {
  assert.equal(slugify("!!!"), "project");
  assert.equal(slugify(""), "project");
});

test("slugify preserves existing hyphens and digits", () => {
  assert.equal(slugify("kedge-stele-v2"), "kedge-stele-v2");
});

// ---- empty registry ------------------------------------------------------

test("loadRegistry returns empty when file missing", () => {
  const r = loadRegistry();
  assert.equal(r.version, 1);
  assert.deepEqual(r.projects, []);
});

test("registryPath lives under $HOME/.stele/", () => {
  assert.ok(registryPath().startsWith(tmpHome + "/"));
  assert.ok(registryPath().endsWith(".stele/registry.json"));
});

// ---- register ------------------------------------------------------------

test("register a fresh path creates entry with slug from basename", () => {
  const r = register("/tmp/foo");
  assert.equal(r.isNew, true);
  assert.equal(r.slug, "foo");
  assert.equal(r.entry.path, "/tmp/foo");
  assert.ok(r.entry.addedAt);
});

test("register is idempotent on path — same path returns same slug, isNew:false", () => {
  const a = register("/tmp/foo");
  const b = register("/tmp/foo");
  assert.equal(b.slug, a.slug);
  assert.equal(b.isNew, false);
  assert.equal(allProjects().length, 1);
});

test("register suffixes slug on basename collision (-2, -3)", () => {
  const a = register("/tmp/foo");
  const b = register("/home/bar/foo");        // same basename
  const c = register("/somewhere/else/foo");  // same basename again
  assert.equal(a.slug, "foo");
  assert.equal(b.slug, "foo-2");
  assert.equal(c.slug, "foo-3");
});

test("register persists across loadRegistry", () => {
  register("/tmp/foo");
  register("/tmp/bar");
  const r = loadRegistry();
  assert.equal(r.projects.length, 2);
  assert.deepEqual(
    r.projects.map((p) => p.slug).sort(),
    ["bar", "foo"],
  );
});

test("register resolves to absolute path", () => {
  // relative paths get resolved against process.cwd()
  const here = process.cwd();
  const r = register(here);
  assert.equal(r.entry.path, here);
});

// ---- findBy --------------------------------------------------------------

test("findBySlug returns the entry or null", () => {
  register("/tmp/foo");
  assert.ok(findBySlug("foo"));
  assert.equal(findBySlug("nope"), null);
});

test("findByPath returns the entry or null", () => {
  register("/tmp/foo");
  assert.ok(findByPath("/tmp/foo"));
  assert.equal(findByPath("/tmp/missing"), null);
});

// ---- unregister ----------------------------------------------------------

test("unregister by slug removes the entry", () => {
  register("/tmp/foo");
  register("/tmp/bar");
  assert.equal(unregister("foo"), true);
  assert.equal(allProjects().length, 1);
  assert.equal(allProjects()[0].slug, "bar");
});

test("unregister by absolute path removes the entry", () => {
  register("/tmp/foo");
  assert.equal(unregister("/tmp/foo"), true);
  assert.equal(allProjects().length, 0);
});

test("unregister returns false when nothing matched", () => {
  register("/tmp/foo");
  assert.equal(unregister("nope"), false);
  assert.equal(allProjects().length, 1);
});

// ---- corrupt registry ----------------------------------------------------

test("loadRegistry tolerates corrupt JSON without throwing", () => {
  // Write invalid JSON to the registry path
  const path = registryPath();
  // mkdir via saveRegistry then overwrite
  saveRegistry({ version: 1, projects: [] });
  writeFileSync(path, "not valid json {{{");
  const r = loadRegistry();
  assert.deepEqual(r.projects, []);
});

test("loadRegistry skips malformed project entries", () => {
  saveRegistry({ version: 1, projects: [] });
  const path = registryPath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      projects: [
        { slug: "good", path: "/tmp/x", addedAt: "2026-06-08T00:00:00Z" },
        { slug: "missing-path" },                          // bad
        null,                                              // bad
        { slug: "ok-too", path: "/tmp/y", addedAt: "2026-06-08T00:00:00Z" },
      ],
    }),
  );
  const r = loadRegistry();
  assert.equal(r.projects.length, 2);
  assert.deepEqual(
    r.projects.map((p) => p.slug).sort(),
    ["good", "ok-too"],
  );
});

// ---- atomic write -------------------------------------------------------

test("saveRegistry produces parseable JSON", () => {
  saveRegistry({ version: 1, projects: [{ slug: "a", path: "/tmp/a", addedAt: "2026-06-08T00:00:00Z" }] });
  const text = readFileSync(registryPath(), "utf8");
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.projects.length, 1);
});
