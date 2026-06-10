// Tests for the pre-0.1.0 → 0.1.0 rename-aside migration in Store's
// constructor. Builds a fake legacy DB with a `decisions(status_kind, ...)`
// table, opens it via Store, asserts the file was renamed aside and a
// fresh schema is in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "./store.ts";

function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "stele-migration-")));
}

test("migration · rename-aside fires for pre-0.1.0 DBs", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "decisions.db");
  try {
    // Build a fake 0.0.7-shaped DB (just enough to trigger the detector)
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE decisions (
        id          TEXT PRIMARY KEY,
        status_kind TEXT NOT NULL,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        data        TEXT NOT NULL
      );
      INSERT INTO decisions VALUES ('D-01', 'decided', 't', '2026-01-01', '{}');
    `);
    legacy.close();

    const s = new Store(dbPath);
    assert.ok(s.migratedFromLegacy, "migratedFromLegacy should be populated");
    assert.equal(s.migratedFromLegacy!.oldPath, dbPath);
    assert.ok(existsSync(s.migratedFromLegacy!.backupPath), "backup file must exist");
    assert.ok(existsSync(dbPath), "a fresh DB must have been created at the original path");
    // The fresh DB has no decisions
    assert.equal(s.allDecisions().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration · backup filename increments when a previous backup exists", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "decisions.db");
  try {
    // First legacy DB
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, status_kind TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);`);
    legacy.close();
    new Store(dbPath); // first migration → decisions.db.0.0.x.db
    unlinkSync(dbPath);  // remove the 0.1.0 fresh schema before dropping a second legacy in its place

    // Drop a second legacy DB at the original path
    const legacy2 = new DatabaseSync(dbPath);
    legacy2.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, status_kind TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);`);
    legacy2.close();

    const s2 = new Store(dbPath);
    assert.ok(s2.migratedFromLegacy);
    // Second backup must not have collided with the first
    assert.notEqual(s2.migratedFromLegacy!.backupPath, `${dbPath}.0.2.x.db`);
    assert.ok(s2.migratedFromLegacy!.backupPath.includes(".0.2.x."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration · fresh DB at a new path is NOT flagged as legacy", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "decisions.db");
  try {
    const s = new Store(dbPath);
    assert.equal(s.migratedFromLegacy, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration · 0.1.0 DB reopening is NOT flagged as legacy", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "decisions.db");
  try {
    new Store(dbPath); // create fresh 0.1.0
    const s = new Store(dbPath); // reopen
    assert.equal(s.migratedFromLegacy, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
