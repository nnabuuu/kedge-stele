// SQLite-backed graph store (0.3.0).
//
// Layer collapse from 0.2.x: the umbrella `Feature` table is gone; the old
// `Milestone` table becomes the new `Feature` table, now a direct child of
// `projects`. Schema: projects, features, sessions, decisions, edges,
// affects, tags (+ taggings + tag_proposals + config — unchanged surface).
//
// Pre-0.3.0 databases are NOT auto-migrated. On open, if the file holds
// any pre-0.3.0 schema (detected via a `milestones` table OR the very-old
// `decisions.status_kind` column), the store renames the file aside to
// `<path>.0.2.x.db` and creates a fresh schema. The user's data is preserved
// in the backup file for manual export via `sqlite3`; see CHANGELOG 0.3.0
// for the migration story.

import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import type {
  Decision,
  DecisionId,
  DecisionResolutionStatus,
  DecisionType,
  Edge,
  EdgeRelation,
  EntityRef,
  Feature,
  FeatureId,
  FeatureState,
  Project,
  ProjectId,
  ProjectStatus,
  ProposalOutcome,
  Session,
  SessionId,
  SessionSource,
  Tag,
  TagId,
  TagProposal,
  TagStatus,
  Tagging,
  TaggingTargetKind,
} from "./types.ts";

// Sentinel exception so the CLI / MCP server can detect the legacy-rename
// case and print a one-time hint without having to sniff stderr.
export class SteleOldSchemaMigrated extends Error {
  oldPath: string;
  backupPath: string;
  constructor(oldPath: string, backupPath: string) {
    super(
      `Stele detected an older (pre-0.3.0) schema at ${oldPath}. ` +
        `The previous database has been preserved at ${backupPath}; a fresh ` +
        `0.3.0 database has been created in its place. To export rows from ` +
        `the backup, query it directly with sqlite3.`,
    );
    this.name = "SteleOldSchemaMigrated";
    this.oldPath = oldPath;
    this.backupPath = backupPath;
  }
}

// One internal flag — set when the constructor renames a legacy DB aside.
// The caller (CLI / MCP) reads `store.migratedFromLegacy` and prints a hint;
// the store itself never writes to stderr.
export class Store {
  private db: DatabaseSync;
  /** Set to the backup path when the constructor renamed a pre-0.3.0 DB aside. */
  readonly migratedFromLegacy: { oldPath: string; backupPath: string } | null = null;

  constructor(path: string) {
    // ---------------------------------------------------------------------
    // Pre-0.3.0 schema detection. We peek at the file first; if it has
    // either the legacy 0.0.x shape (decisions.status_kind) or the 0.1–0.2
    // shape (`milestones` table), we rename it aside and reopen fresh.
    // ---------------------------------------------------------------------
    if (path !== ":memory:" && existsSync(path)) {
      const peek = new DatabaseSync(path);
      const legacy = Store.isLegacySchema(peek);
      peek.close();
      if (legacy) {
        const backupPath = Store.legacyBackupPath(path);
        renameSync(path, backupPath);
        this.migratedFromLegacy = { oldPath: path, backupPath };
      }
    }

    this.db = new DatabaseSync(path);

    // 0.0.7+ — WAL for concurrent reads. No-op for :memory: DBs.
    try {
      this.db.exec(`PRAGMA journal_mode = WAL`);
    } catch {
      /* :memory: rejects WAL */
    }
    // Foreign keys help catch reference bugs in dev; we don't rely on cascade.
    try { this.db.exec(`PRAGMA foreign_keys = ON`); } catch { /* ignore */ }

    this.db.exec(`
      -- 0.1.0+ — projects (was 0.0.7's registry.json {slug,path,addedAt})
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        code        TEXT,
        path        TEXT NOT NULL,
        status      TEXT NOT NULL CHECK(status IN ('active','winding','dormant','archived')),
        created_at  TEXT NOT NULL,
        data        TEXT NOT NULL
      );

      -- 0.3.0 — features (was milestones in 0.2.x; the umbrella feature table is gone).
      -- Direct child of projects. Carries state + about + dates + rolling summary.
      CREATE TABLE IF NOT EXISTS features (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        state       TEXT NOT NULL CHECK(state IN ('draft','going','winding','done','paused')),
        name        TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        data        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id);
      CREATE INDEX IF NOT EXISTS idx_features_state   ON features(state);

      -- 0.3.0 — sessions (FK rename: milestone_id → feature_id; outcome/pause_reason
      -- still live in the data column for legacy decoding, but new captures don't write them)
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        feature_id      TEXT NOT NULL REFERENCES features(id),
        source          TEXT NOT NULL,
        source_sess_id  TEXT,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        data            TEXT NOT NULL,
        UNIQUE(source, source_sess_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_feature ON sessions(feature_id);

      -- 0.3.0 — decisions (FK rename: milestone_id → feature_id)
      -- 0.4.0 — adds source / dedup_key columns. Both are nullable so legacy
      -- rows decode unchanged; the UNIQUE constraint on dedup_key skips
      -- WHERE dedup_key IS NULL via the partial index below.
      CREATE TABLE IF NOT EXISTS decisions (
        id              TEXT PRIMARY KEY,
        feature_id      TEXT NOT NULL REFERENCES features(id),
        session_id      TEXT REFERENCES sessions(id),
        type            TEXT NOT NULL CHECK(type IN ('decision','deferred','open')),
        status          TEXT CHECK(status IN ('open','resolved')),  -- nullable for type='decision'
        resolved_by     TEXT,                                       -- FK self-reference
        superseded_by   TEXT,                                       -- FK self-reference
        title           TEXT NOT NULL,
        source          TEXT CHECK(source IN ('manual','agent-live','session-extract')),
        dedup_key       TEXT,
        created_at      TEXT NOT NULL,
        data            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_feature ON decisions(feature_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_type    ON decisions(type);
      CREATE INDEX IF NOT EXISTS idx_decisions_status  ON decisions(status);
      -- 0.4.0 indexes on source / dedup_key are created inside
      -- applySoftMigrations_0_4_0(), because upgrading a 0.3 DB has to ALTER
      -- the columns in first.

      -- 0.1.0+ — edges (relation, not kind; depends_on is valid)
      CREATE TABLE IF NOT EXISTS edges (
        from_id   TEXT NOT NULL,
        to_id     TEXT NOT NULL,
        relation  TEXT NOT NULL CHECK(relation IN ('resolves','supersedes','reconciles','relates','depends_on')),
        note      TEXT,
        UNIQUE(from_id, to_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_to       ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);

      -- affects reverse index (unchanged)
      CREATE TABLE IF NOT EXISTS affects (
        decision_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        UNIQUE(decision_id, entity_kind, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_affects_entity ON affects(entity_kind, entity_id);

      -- 0.0.7 — tag system (unchanged except for taggings.target_kind values: 'milestone'→'feature')
      CREATE TABLE IF NOT EXISTS tags (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color       TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'scope',
        origin      TEXT NOT NULL CHECK(origin IN ('you','agent')),
        status      TEXT NOT NULL CHECK(status IN ('active','archived')),
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tags_status ON tags(status);

      CREATE TABLE IF NOT EXISTS taggings (
        tag_id      TEXT NOT NULL REFERENCES tags(id),
        target_kind TEXT NOT NULL CHECK(target_kind IN ('feature','decision')),
        target_id   TEXT NOT NULL,
        PRIMARY KEY (tag_id, target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_taggings_target ON taggings(target_kind, target_id);

      CREATE TABLE IF NOT EXISTS tag_proposals (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        suggested_color TEXT,
        reason          TEXT,
        targets         TEXT NOT NULL,
        outcome         TEXT NOT NULL CHECK(outcome IN ('pending','blocked','auto_adopted')),
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_outcome ON tag_proposals(outcome);
      CREATE INDEX IF NOT EXISTS idx_proposals_name    ON tag_proposals(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // 0.4.0 — soft additive migration for 0.3.0 DBs already on disk.
    // CREATE TABLE IF NOT EXISTS won't ALTER an existing table; explicitly
    // probe for the new columns and add them when missing. Idempotent.
    this.applySoftMigrations_0_4_0();
  }

  /**
   * Additive ALTERs for 0.3.0 → 0.4.0 DBs. New columns are nullable so legacy
   * rows decode unchanged; the partial UNIQUE index on `dedup_key` only kicks
   * in for rows that 0.4.0+ writes.
   */
  private applySoftMigrations_0_4_0(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(decisions)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("source")) {
      this.db.exec(
        `ALTER TABLE decisions ADD COLUMN source TEXT ` +
        `CHECK(source IN ('manual','agent-live','session-extract'))`,
      );
    }
    if (!names.has("dedup_key")) {
      this.db.exec(`ALTER TABLE decisions ADD COLUMN dedup_key TEXT`);
    }
    // Indexes are idempotent via IF NOT EXISTS.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_decisions_dedup_key
        ON decisions(dedup_key) WHERE dedup_key IS NOT NULL;
    `);
  }

  // ---- legacy detection helpers --------------------------------------------

  private static isLegacySchema(db: DatabaseSync): boolean {
    // Two legacy fingerprints:
    //   - 0.0.x: decisions.status_kind column
    //   - 0.1-0.2: milestones table exists
    const hasMilestones = !!db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='milestones'`)
      .get();
    if (hasMilestones) return true;
    const hasDecisions = !!db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'`)
      .get();
    if (!hasDecisions) return false;
    const cols = db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === "status_kind" || c.name === "milestone_id");
  }

  private static legacyBackupPath(path: string): string {
    // Increment suffix until a free filename is found.
    let i = 0;
    for (;;) {
      const candidate = i === 0
        ? `${path}.0.2.x.db`
        : `${path}.0.2.x.${i}.db`;
      if (!existsSync(candidate)) return candidate;
      i++;
    }
  }

  // =========================================================================
  // 0.1.0+ — projects
  // =========================================================================

  putProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, code, path, status, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           code       = excluded.code,
           path       = excluded.path,
           status     = excluded.status,
           data       = excluded.data`,
      )
      .run(p.id, p.name, p.code ?? null, p.path, p.status, p.createdAt, JSON.stringify(p));
  }

  getProject(id: ProjectId): Project | null {
    const row = this.db.prepare(`SELECT data FROM projects WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Project) : null;
  }

  allProjects(): Project[] {
    const rows = this.db.prepare(`SELECT data FROM projects ORDER BY created_at, id`).all() as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as Project);
  }

  byProjectStatus(status: ProjectStatus): Project[] {
    const rows = this.db
      .prepare(`SELECT data FROM projects WHERE status = ? ORDER BY created_at, id`)
      .all(status) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Project);
  }

  /**
   * Each .stele/decisions.db is per-project; in normal flow there is exactly
   * one Project row. Returns it, or null if none exists yet (which usually
   * means `stele init` hasn't been run).
   */
  theProject(): Project | null {
    const all = this.allProjects();
    return all[0] ?? null;
  }

  nextProjectId(): ProjectId {
    return this.nextSequencedId("projects", "P");
  }

  // =========================================================================
  // 0.3.0 — features (direct child of projects; carries state + about + dates)
  // =========================================================================

  putFeature(f: Feature): void {
    // Feature ids appear inside Decision ids as `<featureId>/<local>`,
    // so a feature id with `/` would break that format. Reject early.
    // The `__unscoped:` sentinel is reserved for the auto-created
    // unscoped feature — see ensureUnscopedFeature.
    if (f.id.includes("/")) {
      throw new Error(`feature id must not contain '/': got "${f.id}"`);
    }
    if (f.id.startsWith("__unscoped:") && f.id !== `__unscoped:${f.projectId}`) {
      throw new Error(`reserved feature id "${f.id}" — use ensureUnscopedFeature`);
    }
    this.db
      .prepare(
        `INSERT INTO features (id, project_id, state, name, started_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           state      = excluded.state,
           name       = excluded.name,
           data       = excluded.data`,
      )
      .run(f.id, f.projectId, f.state, f.name, f.startedAt, JSON.stringify(f));
  }

  getFeature(id: FeatureId): Feature | null {
    const row = this.db.prepare(`SELECT data FROM features WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Feature) : null;
  }

  allFeatures(): Feature[] {
    const rows = this.db
      .prepare(`SELECT data FROM features ORDER BY started_at, id`)
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Feature);
  }

  byFeatureState(state: FeatureState): Feature[] {
    const rows = this.db
      .prepare(`SELECT data FROM features WHERE state = ? ORDER BY started_at, id`)
      .all(state) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Feature);
  }

  featuresInProject(projectId: ProjectId): Feature[] {
    const rows = this.db
      .prepare(`SELECT data FROM features WHERE project_id = ? ORDER BY started_at, id`)
      .all(projectId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Feature);
  }

  nextFeatureId(): FeatureId {
    return this.nextSequencedId("features", "F");
  }

  /**
   * Find-or-create the per-project unscoped Feature. Used by the
   * `feature.mode='unscoped'` capture path so unscoped decisions still
   * live under a real Feature parent.
   */
  ensureUnscopedFeature(projectId: ProjectId): Feature {
    const id = `__unscoped:${projectId}`;
    const existing = this.getFeature(id);
    if (existing) return existing;
    const f: Feature = {
      id,
      projectId,
      name: "unscoped",
      state: "going",
      about: "Decisions captured without an explicit feature.",
      startedAt: new Date().toISOString(),
    };
    this.putFeature(f);
    return f;
  }

  /** Update feature state without rewriting the whole record. */
  setFeatureState(id: FeatureId, state: FeatureState): void {
    const f = this.getFeature(id);
    if (!f) throw new Error(`no such feature: ${id}`);
    f.state = state;
    if (state === "done") f.completedAt = f.completedAt ?? new Date().toISOString();
    this.putFeature(f);
  }

  /**
   * Write the rolling Feature.summary (the field /stele:feature rewrites on
   * each reconcile pass). Replace, not append — the summary is meant to
   * reflect the CURRENT state, not the audit trail. Passing an empty string
   * clears the summary.
   */
  setFeatureSummary(id: FeatureId, summary: string): void {
    const f = this.getFeature(id);
    if (!f) throw new Error(`no such feature: ${id}`);
    f.summary = summary || undefined;
    this.putFeature(f);
  }

  // =========================================================================
  // 0.3.0 — sessions (FK rename; provenance + legacy outcome/pause_reason in data)
  // =========================================================================

  putSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, feature_id, source, source_sess_id, started_at, ended_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           feature_id     = excluded.feature_id,
           source         = excluded.source,
           source_sess_id = excluded.source_sess_id,
           ended_at       = excluded.ended_at,
           data           = excluded.data`,
      )
      .run(
        s.id, s.featureId, s.source, s.sourceSessionId ?? null,
        s.startedAt, s.endedAt ?? null, JSON.stringify(s),
      );
  }

  getSession(id: SessionId): Session | null {
    const row = this.db.prepare(`SELECT data FROM sessions WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  findSession(source: SessionSource, sourceSessionId: string): Session | null {
    const row = this.db
      .prepare(`SELECT data FROM sessions WHERE source = ? AND source_sess_id = ? LIMIT 1`)
      .get(source, sourceSessionId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  sessionsInFeature(id: FeatureId): Session[] {
    const rows = this.db
      .prepare(`SELECT data FROM sessions WHERE feature_id = ? ORDER BY started_at, id`)
      .all(id) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Session);
  }

  /** Latest session across the whole store (used for "what's the resume strip"). */
  latestSession(): Session | null {
    const row = this.db
      .prepare(`SELECT data FROM sessions ORDER BY started_at DESC LIMIT 1`)
      .get() as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  latestSessionInFeature(id: FeatureId): Session | null {
    const row = this.db
      .prepare(`SELECT data FROM sessions WHERE feature_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  // =========================================================================
  // 0.3.0 — decisions (FK rename)
  // =========================================================================

  /**
   * Write a Decision, deduping against the (featureId, normalized title,
   * affects) signature when the caller marks the decision as machine-captured
   * (source ∈ {agent-live, session-extract}).
   *
   * Returns:
   *   - { written: true, id }                   — fresh row inserted (or in-place id update)
   *   - { written: false, dedupedTo: existing } — same content already on disk;
   *                                              the caller can use `existing` as the canonical id
   *
   * Manual / legacy captures (source omitted or 'manual') skip the dedup check
   * entirely — humans authoring on purpose want their write honored. The
   * partial UNIQUE index in DDL only fires when dedup_key IS NOT NULL.
   */
  putDecision(d: Decision): { written: true; id: DecisionId } | { written: false; dedupedTo: DecisionId } {
    const isMachine = d.source === "agent-live" || d.source === "session-extract";
    let dedupKey: string | null = null;
    if (isMachine) {
      dedupKey = Store.computeDedupKey(d);
      // Check before insert so we can return the existing id without raising
      // a UNIQUE violation. Same-id re-writes from the agent are NOT dedups —
      // they're legitimate updates (e.g. adding `resolvedBy`).
      const existing = this.db
        .prepare(`SELECT id FROM decisions WHERE dedup_key = ? AND id != ?`)
        .get(dedupKey, d.id) as { id: string } | undefined;
      if (existing) return { written: false, dedupedTo: existing.id };
    }

    // Persist the resolved dedupKey on the JSON blob so it round-trips through
    // getDecision() — keeps it visible to projections / the SPA without a join.
    const persisted: Decision = dedupKey ? { ...d, dedupKey } : d;

    this.db
      .prepare(
        `INSERT INTO decisions
           (id, feature_id, session_id, type, status, resolved_by, superseded_by, title, source, dedup_key, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           feature_id    = excluded.feature_id,
           session_id    = excluded.session_id,
           type          = excluded.type,
           status        = excluded.status,
           resolved_by   = excluded.resolved_by,
           superseded_by = excluded.superseded_by,
           title         = excluded.title,
           source        = excluded.source,
           dedup_key     = excluded.dedup_key,
           data          = excluded.data`,
      )
      .run(
        d.id, d.featureId, d.sessionId ?? null,
        d.type, d.status ?? null,
        d.resolvedBy ?? null, d.supersededBy ?? null,
        d.title,
        d.source ?? null,
        dedupKey,
        d.createdAt, JSON.stringify(persisted),
      );

    // Refresh the affects reverse index.
    this.db.prepare(`DELETE FROM affects WHERE decision_id = ?`).run(d.id);
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO affects (decision_id, entity_kind, entity_id) VALUES (?, ?, ?)`,
    );
    for (const e of d.affects) ins.run(d.id, e.kind, e.id);
    return { written: true, id: d.id };
  }

  /**
   * Stable signature of a Decision's content for dedup. Computed from
   * (featureId, normalized title, affects); does NOT include id, type,
   * status — the same observation captured as 'decision' vs 'open' should
   * still collide because it represents the same underlying decision moment.
   */
  static computeDedupKey(d: Decision): string {
    const norm = d.title.toLowerCase().trim().replace(/\s+/g, " ");
    const affects = [...d.affects]
      .map((e) => `${e.kind}:${e.id}`)
      .sort()
      .join(",");
    return createHash("sha256")
      .update(`${d.featureId}|${norm}|${affects}`)
      .digest("hex")
      .slice(0, 16);
  }

  getDecision(id: DecisionId): Decision | null {
    const row = this.db.prepare(`SELECT data FROM decisions WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Decision) : null;
  }

  allDecisions(): Decision[] {
    const rows = this.db.prepare(`SELECT data FROM decisions ORDER BY created_at, id`).all() as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }

  /**
   * Query decisions by type, optionally also by status.
   * Pass `status: null` to mean "WHERE status IS NULL" (i.e. type='decision'
   * rows that have no resolution state). Pass undefined to ignore status.
   */
  byDecisionType(
    type: DecisionType,
    status?: DecisionResolutionStatus | null,
  ): Decision[] {
    let sql = `SELECT data FROM decisions WHERE type = ?`;
    const params: string[] = [type];
    if (status === null) {
      sql += ` AND status IS NULL`;
    } else if (status !== undefined) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY created_at, id`;
    const rows = this.db.prepare(sql).all(...params) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }

  decisionsInSession(id: SessionId): Decision[] {
    const rows = this.db
      .prepare(`SELECT data FROM decisions WHERE session_id = ? ORDER BY created_at, id`)
      .all(id) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }

  decisionsInFeature(id: FeatureId): Decision[] {
    const rows = this.db
      .prepare(`SELECT data FROM decisions WHERE feature_id = ? ORDER BY created_at, id`)
      .all(id) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }

  /**
   * Allocate the next `<featureId>/{D|DEF|OQ}-NN` slot for a feature+type.
   * The status-prefixed local id keeps a glance at the id telling you the
   * shape (decided vs deferred vs open) without a JOIN.
   */
  nextLocalDecisionId(featureId: FeatureId, type: DecisionType): DecisionId {
    const prefix = type === "decision" ? "D" : type === "deferred" ? "DEF" : "OQ";
    const escFt = featureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escFt}/${prefix}-(\\d+)$`);
    const rows = this.db
      .prepare(`SELECT id FROM decisions WHERE feature_id = ? AND type = ?`)
      .all(featureId, type) as { id: string }[];
    let max = 0;
    for (const r of rows) {
      const m = r.id.match(pattern);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return `${featureId}/${prefix}-${String(max + 1).padStart(2, "0")}`;
  }

  /**
   * Set the resolution side of a deferred/open decision.
   * Used by addEdge(resolves) to flip target on `resolves` edge insert.
   * Wrapped in BEGIN IMMEDIATE so a concurrent `setDecisionSuperseded`
   * on the same row from the always-on daemon can't clobber the JSON
   * `data` blob between read and write.
   */
  setDecisionResolved(id: DecisionId, resolvedBy: DecisionId): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const d = this.getDecision(id);
      if (!d) throw new Error(`no such decision: ${id}`);
      d.status = "resolved";
      d.resolvedBy = resolvedBy;
      this.putDecision(d);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Mark a Feature complete: close every still-open / deferred decision on it as
   * MANUALLY closed (status='resolved' so it leaves the open-loop set used by
   * nodeState / openLoops / resumeDigest, but resolvedBy stays unset and a
   * `closedManually` marker records the hand-close), then move the Feature to
   * 'done'. Returns the ids that were closed. One transaction so the sweep
   * can't tear under the always-on daemon.
   */
  markFeatureComplete(
    id: FeatureId,
    opts: { at?: string; by?: string; reason?: string } = {},
  ): { closed: DecisionId[] } {
    const at = opts.at ?? new Date().toISOString();
    const closed: DecisionId[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const f = this.getFeature(id);
      if (!f) throw new Error(`no such feature: ${id}`);
      for (const d of this.decisionsInFeature(id)) {
        if ((d.type === "deferred" || d.type === "open") && d.status !== "resolved") {
          d.status = "resolved";
          d.closedManually = { at, by: opts.by, reason: opts.reason };
          this.putDecision(d);
          closed.push(d.id);
        }
      }
      this.setFeatureState(id, "done"); // stamps completedAt
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { closed };
  }

  /**
   * Mark a type='decision' as superseded by another decision.
   * Used by addEdge(supersedes). See setDecisionResolved for the
   * concurrency rationale.
   */
  setDecisionSuperseded(id: DecisionId, supersededBy: DecisionId): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const d = this.getDecision(id);
      if (!d) throw new Error(`no such decision: ${id}`);
      d.supersededBy = supersededBy;
      this.putDecision(d);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // =========================================================================
  // 0.1.0+ — edges (relation, not kind)
  // =========================================================================

  /**
   * Adding a `resolves` edge flips the target's `status` to 'resolved' and
   * writes `resolved_by`. `supersedes` writes `superseded_by`. The other
   * relations (`relates`, `reconciles`, `depends_on`) are non-mutating —
   * they just record the link.
   *
   * This is the core invariant: a deferred decision from one report becomes
   * "resolved by D-B" three weeks later when someone adds the edge, and
   * every projection updates because it reads the live node, not a snapshot.
   */
  addEdge(e: Edge): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO edges (from_id, to_id, relation, note) VALUES (?, ?, ?, ?)`)
      .run(e.from, e.to, e.relation, e.note ?? null);

    if (e.relation === "resolves") this.setDecisionResolved(e.to, e.from);
    if (e.relation === "supersedes") this.setDecisionSuperseded(e.to, e.from);
  }

  edgesFrom(id: DecisionId): Edge[] {
    return (
      this.db.prepare(`SELECT from_id, to_id, relation, note FROM edges WHERE from_id = ?`).all(id) as any[]
    ).map((r) => ({ from: r.from_id, to: r.to_id, relation: r.relation as EdgeRelation, note: r.note ?? undefined }));
  }

  edgesTo(id: DecisionId): Edge[] {
    return (
      this.db.prepare(`SELECT from_id, to_id, relation, note FROM edges WHERE to_id = ?`).all(id) as any[]
    ).map((r) => ({ from: r.from_id, to: r.to_id, relation: r.relation as EdgeRelation, note: r.note ?? undefined }));
  }

  // ---- queries the store answers WITHOUT an ontology ----------------------

  decisionsAffecting(ref: EntityRef): Decision[] {
    const rows = this.db
      .prepare(`SELECT decision_id FROM affects WHERE entity_kind = ? AND entity_id = ?`)
      .all(ref.kind, ref.id) as { decision_id: string }[];
    return rows.map((r) => this.getDecision(r.decision_id)!).filter(Boolean);
  }

  /** True if any incoming `resolves` edge exists. */
  isResolved(id: DecisionId): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM edges WHERE to_id = ? AND relation = 'resolves' LIMIT 1`)
      .get(id);
    return !!row;
  }

  // =========================================================================
  // 0.0.7 — tags (carried over verbatim)
  // =========================================================================

  putTag(t: Tag): Tag {
    this.db
      .prepare(
        `INSERT INTO tags (id, name, color, kind, origin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name   = excluded.name,
           color  = excluded.color,
           kind   = excluded.kind,
           status = excluded.status`,
      )
      .run(t.id, t.name, t.color, t.kind ?? "scope", t.origin, t.status, t.createdAt);
    return t;
  }

  getTag(id: TagId): Tag | null {
    const row = this.db
      .prepare(`SELECT id, name, color, kind, origin, status, created_at FROM tags WHERE id = ?`)
      .get(id) as
      | { id: string; name: string; color: string; kind: string; origin: string; status: TagStatus; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id, name: row.name, color: row.color, kind: row.kind,
      origin: row.origin as Tag["origin"], status: row.status, createdAt: row.created_at,
    };
  }

  findTagByName(name: string): Tag | null {
    const row = this.db
      .prepare(`SELECT id, name, color, kind, origin, status, created_at FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1`)
      .get(name) as
      | { id: string; name: string; color: string; kind: string; origin: string; status: TagStatus; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id, name: row.name, color: row.color, kind: row.kind,
      origin: row.origin as Tag["origin"], status: row.status, createdAt: row.created_at,
    };
  }

  // Returns each tag with `count` = how many targets it's applied to (the Tags
  // library's "N 处在用" cell). count is additive; plain Tag[] consumers ignore it.
  allTags(status?: TagStatus): Array<Tag & { count: number }> {
    const where = status ? `WHERE t.status = ?` : ``;
    const sql =
      `SELECT t.id, t.name, t.color, t.kind, t.origin, t.status, t.created_at,
         (SELECT COUNT(*) FROM taggings tg WHERE tg.tag_id = t.id) AS count
       FROM tags t ${where} ORDER BY t.name COLLATE NOCASE`;
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as Array<{
      id: string; name: string; color: string; kind: string; origin: string; status: TagStatus; created_at: string; count: number;
    }>;
    return rows.map((r) => ({
      id: r.id, name: r.name, color: r.color, kind: r.kind,
      origin: r.origin as Tag["origin"], status: r.status, createdAt: r.created_at, count: r.count,
    }));
  }

  renameTag(id: TagId, name: string): void {
    this.db.prepare(`UPDATE tags SET name = ? WHERE id = ?`).run(name, id);
  }
  recolorTag(id: TagId, color: string): void {
    this.db.prepare(`UPDATE tags SET color = ? WHERE id = ?`).run(color, id);
  }
  archiveTag(id: TagId): void {
    this.db.prepare(`UPDATE tags SET status = 'archived' WHERE id = ?`).run(id);
  }
  restoreTag(id: TagId): void {
    this.db.prepare(`UPDATE tags SET status = 'active' WHERE id = ?`).run(id);
  }

  upsertTagging(tag: Tagging): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO taggings (tag_id, target_kind, target_id) VALUES (?, ?, ?)`)
      .run(tag.tagId, tag.targetKind, tag.targetId);
  }

  removeTagging(tagId: TagId, targetKind: TaggingTargetKind, targetId: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM taggings WHERE tag_id = ? AND target_kind = ? AND target_id = ?`)
      .run(tagId, targetKind, targetId);
    return r.changes > 0;
  }

  taggingsForTarget(targetKind: TaggingTargetKind, targetId: string): Tag[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.color, t.kind, t.origin, t.status, t.created_at
         FROM taggings tg JOIN tags t ON t.id = tg.tag_id
         WHERE tg.target_kind = ? AND tg.target_id = ?
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all(targetKind, targetId) as Array<{
        id: string; name: string; color: string; kind: string; origin: string; status: TagStatus; created_at: string;
      }>;
    return rows.map((r) => ({
      id: r.id, name: r.name, color: r.color, kind: r.kind,
      origin: r.origin as Tag["origin"], status: r.status, createdAt: r.created_at,
    }));
  }

  targetsForTag(tagId: TagId): Array<{ kind: TaggingTargetKind; id: string }> {
    const rows = this.db
      .prepare(`SELECT target_kind, target_id FROM taggings WHERE tag_id = ?`)
      .all(tagId) as Array<{ target_kind: TaggingTargetKind; target_id: string }>;
    return rows.map((r) => ({ kind: r.target_kind, id: r.target_id }));
  }

  putTagProposal(p: TagProposal): TagProposal {
    this.db
      .prepare(
        `INSERT INTO tag_proposals (id, name, suggested_color, reason, targets, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name            = excluded.name,
           suggested_color = excluded.suggested_color,
           reason          = excluded.reason,
           targets         = excluded.targets,
           outcome         = excluded.outcome`,
      )
      .run(
        p.id, p.name, p.suggestedColor ?? null, p.reason ?? null,
        JSON.stringify(p.targets), p.outcome, p.createdAt,
      );
    return p;
  }

  upsertProposalByName(p: TagProposal): TagProposal {
    const existing = this.db
      .prepare(
        `SELECT id, name, suggested_color, reason, targets, outcome, created_at
         FROM tag_proposals
         WHERE name = ? COLLATE NOCASE AND outcome = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(p.name, p.outcome) as
      | { id: string; name: string; suggested_color: string | null; reason: string | null; targets: string; outcome: ProposalOutcome; created_at: string }
      | undefined;
    if (!existing) return this.putTagProposal(p);
    const existingTargets = JSON.parse(existing.targets) as { kind: TaggingTargetKind; id: string }[];
    const merged = new Map<string, { kind: TaggingTargetKind; id: string }>();
    for (const t of [...existingTargets, ...p.targets]) merged.set(`${t.kind}:${t.id}`, t);
    const updated: TagProposal = {
      id: existing.id,
      name: existing.name,
      suggestedColor: p.suggestedColor ?? existing.suggested_color ?? undefined,
      reason: p.reason ?? existing.reason ?? undefined,
      targets: Array.from(merged.values()),
      outcome: existing.outcome,
      createdAt: existing.created_at,
    };
    return this.putTagProposal(updated);
  }

  getTagProposal(id: string): TagProposal | null {
    const row = this.db
      .prepare(`SELECT id, name, suggested_color, reason, targets, outcome, created_at FROM tag_proposals WHERE id = ?`)
      .get(id) as
      | { id: string; name: string; suggested_color: string | null; reason: string | null; targets: string; outcome: ProposalOutcome; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id, name: row.name,
      suggestedColor: row.suggested_color ?? undefined,
      reason: row.reason ?? undefined,
      targets: JSON.parse(row.targets) as { kind: TaggingTargetKind; id: string }[],
      outcome: row.outcome, createdAt: row.created_at,
    };
  }

  allTagProposals(outcome?: ProposalOutcome): TagProposal[] {
    const sql = outcome
      ? `SELECT id, name, suggested_color, reason, targets, outcome, created_at FROM tag_proposals WHERE outcome = ? ORDER BY created_at DESC`
      : `SELECT id, name, suggested_color, reason, targets, outcome, created_at FROM tag_proposals ORDER BY created_at DESC`;
    const rows = (outcome ? this.db.prepare(sql).all(outcome) : this.db.prepare(sql).all()) as Array<{
      id: string; name: string; suggested_color: string | null; reason: string | null; targets: string; outcome: ProposalOutcome; created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id, name: r.name,
      suggestedColor: r.suggested_color ?? undefined,
      reason: r.reason ?? undefined,
      targets: JSON.parse(r.targets) as { kind: TaggingTargetKind; id: string }[],
      outcome: r.outcome, createdAt: r.created_at,
    }));
  }

  deleteTagProposal(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM tag_proposals WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  // =========================================================================
  // 0.0.7 — config (carried over)
  // =========================================================================

  setConfig(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  getConfig(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  allConfig(): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM config`).all() as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /** Allocate `<prefix>-NN` for projects / features. */
  private nextSequencedId(table: "projects" | "features", prefix: string): string {
    const pattern = new RegExp(`^${prefix}-(\\d+)$`);
    const rows = this.db.prepare(`SELECT id FROM ${table}`).all() as { id: string }[];
    let max = 0;
    for (const r of rows) {
      const m = r.id.match(pattern);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return `${prefix}-${String(max + 1).padStart(2, "0")}`;
  }
}
