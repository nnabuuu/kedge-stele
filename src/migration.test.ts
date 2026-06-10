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

// 0.4.0 — additive ALTER for the source / dedup_key columns
test("migration · 0.3.0 DB opens cleanly and gains the 0.4.0 columns via ALTER", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "decisions.db");
  try {
    // Simulate a pre-0.4 schema: same as current, minus the two new columns
    // and minus the partial UNIQUE index.
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT,
        path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','winding','dormant','archived')),
        created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE features (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        state TEXT NOT NULL CHECK(state IN ('draft','going','winding','done','paused')),
        name TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES features(id),
        source TEXT NOT NULL, source_sess_id TEXT,
        started_at TEXT NOT NULL, ended_at TEXT, data TEXT NOT NULL,
        UNIQUE(source, source_sess_id)
      );
      -- Pre-0.4 decisions: no source / dedup_key columns
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL REFERENCES features(id),
        session_id TEXT REFERENCES sessions(id),
        type TEXT NOT NULL CHECK(type IN ('decision','deferred','open')),
        status TEXT CHECK(status IN ('open','resolved')),
        resolved_by TEXT, superseded_by TEXT,
        title TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('P-01', 'x', NULL, '/x', 'active', '2026-01-01', '{}');
      INSERT INTO features VALUES ('F-01', 'P-01', 'going', 'x', '2026-01-01', '{}');
      INSERT INTO decisions VALUES (
        'F-01/D-01', 'F-01', NULL, 'decision', NULL, NULL, NULL,
        'legacy decided', '2026-01-01', '{"id":"F-01/D-01","featureId":"F-01","type":"decision","title":"legacy decided","raisedBy":{"trigger":"t","actor":"a","layer":"personal","at":"2026-01-01"},"detail":{"options":[]},"affects":[],"createdAt":"2026-01-01"}'
      );
    `);
    old.close();

    // Open via 0.4.0 Store. NO rename-aside (not a pre-0.3 shape) — just
    // additive ALTER.
    const s = new Store(dbPath);
    assert.equal(s.migratedFromLegacy, null, "0.3 → 0.4 is additive, not rename-aside");

    // The legacy row is still there + readable
    const legacy = s.getDecision("F-01/D-01");
    assert.ok(legacy, "pre-0.4 row survived the ALTER");
    assert.equal(legacy!.title, "legacy decided");
    assert.equal(legacy!.source, undefined);

    // And new captures can write into the now-upgraded columns
    s.putDecision({
      id: "F-01/D-02", featureId: "F-01", type: "decision",
      title: "new decided",
      raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-10" },
      detail: { options: [] },
      affects: [{ kind: "file", id: "src/x.ts" }],
      source: "agent-live", confidence: 0.8,
      createdAt: "2026-06-10",
    });
    const fresh = s.getDecision("F-01/D-02")!;
    assert.equal(fresh.source, "agent-live");
    assert.equal(fresh.confidence, 0.8);
    assert.ok(fresh.dedupKey, "dedupKey computed for the new row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
