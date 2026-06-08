import { DatabaseSync } from "node:sqlite";
import type {
  Decision,
  DecisionId,
  Edge,
  EntityRef,
  Milestone,
  MilestoneId,
  MilestoneStatus,
  Session,
  SessionId,
  SessionSource,
  Status,
  StatusKind,
} from "./types.ts";

// The store owns the graph. It needs NO ontology to answer "which decisions
// touched entity X" — it keeps its own reverse index of affects edges.
//
// 0.0.6 added milestones + sessions tables; decisions gained an optional
// session_id column via a lazy ALTER on existing databases.
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id          TEXT PRIMARY KEY,
        status_kind TEXT NOT NULL,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        data        TEXT NOT NULL          -- full Decision as JSON
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_id TEXT NOT NULL,
        to_id   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        note    TEXT,
        UNIQUE(from_id, to_id, kind)
      );
      CREATE TABLE IF NOT EXISTS affects (
        decision_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        UNIQUE(decision_id, entity_kind, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_affects_entity ON affects(entity_kind, entity_id);

      -- 0.0.6 — milestones + sessions
      CREATE TABLE IF NOT EXISTS milestones (
        id          TEXT PRIMARY KEY,
        status      TEXT NOT NULL,            -- 'active' | 'shipped' | 'abandoned'
        title       TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        data        TEXT NOT NULL             -- full Milestone JSON
      );
      CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status);

      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        milestone_id    TEXT NOT NULL,
        source          TEXT NOT NULL,
        source_sess_id  TEXT,                 -- nullable
        started_at      TEXT NOT NULL,
        data            TEXT NOT NULL,
        UNIQUE(source, source_sess_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_milestone ON sessions(milestone_id);

      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(json_extract(data, '$.sessionId'));
    `);

    // ALTER TABLE decisions ADD COLUMN session_id — idempotent. SQLite's
    // ALTER throws if the column exists; we catch and ignore. Pre-0.0.6
    // databases get the column with NULL for every existing row.
    try {
      this.db.exec(`ALTER TABLE decisions ADD COLUMN session_id TEXT`);
    } catch {
      // column already exists
    }
  }

  // ---- decisions -----------------------------------------------------------

  putDecision(d: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, status_kind, title, created_at, data, session_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status_kind = excluded.status_kind,
           title       = excluded.title,
           data        = excluded.data,
           session_id  = excluded.session_id`
      )
      .run(d.id, d.status.kind, d.title, d.raisedBy.at, JSON.stringify(d), d.sessionId ?? null);

    this.db.prepare(`DELETE FROM affects WHERE decision_id = ?`).run(d.id);
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO affects (decision_id, entity_kind, entity_id) VALUES (?, ?, ?)`
    );
    for (const e of d.affects) ins.run(d.id, e.kind, e.id);
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

  setStatus(id: DecisionId, status: Status): void {
    const d = this.getDecision(id);
    if (!d) throw new Error(`no such decision: ${id}`);
    d.status = status;
    this.putDecision(d);
  }

  // ---- edges ----------------------------------------------------------------

  // Adding a resolves/supersedes edge flips the *target* status. This is the
  // whole point: DEF-02 from one report becomes "resolved by D-B" three weeks
  // later, and every projection updates because it reads the node, not a snapshot.
  addEdge(e: Edge): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO edges (from_id, to_id, kind, note) VALUES (?, ?, ?, ?)`)
      .run(e.from, e.to, e.kind, e.note ?? null);

    if (e.kind === "resolves") this.setStatus(e.to, { kind: "resolved", by: e.from });
    if (e.kind === "supersedes") this.setStatus(e.to, { kind: "superseded", by: e.from });
  }

  edgesFrom(id: DecisionId): Edge[] {
    return (
      this.db.prepare(`SELECT from_id, to_id, kind, note FROM edges WHERE from_id = ?`).all(id) as any[]
    ).map((r) => ({ from: r.from_id, to: r.to_id, kind: r.kind, note: r.note ?? undefined }));
  }

  edgesTo(id: DecisionId): Edge[] {
    return (
      this.db.prepare(`SELECT from_id, to_id, kind, note FROM edges WHERE to_id = ?`).all(id) as any[]
    ).map((r) => ({ from: r.from_id, to: r.to_id, kind: r.kind, note: r.note ?? undefined }));
  }

  // ---- queries the store answers WITHOUT ontology --------------------------

  decisionsAffecting(ref: EntityRef): Decision[] {
    const rows = this.db
      .prepare(`SELECT decision_id FROM affects WHERE entity_kind = ? AND entity_id = ?`)
      .all(ref.kind, ref.id) as { decision_id: string }[];
    return rows.map((r) => this.getDecision(r.decision_id)!).filter(Boolean);
  }

  byStatusKind(kind: StatusKind): Decision[] {
    const rows = this.db
      .prepare(`SELECT data FROM decisions WHERE status_kind = ? ORDER BY created_at, id`)
      .all(kind) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }

  // has any incoming "resolves" edge?
  isResolved(id: DecisionId): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM edges WHERE to_id = ? AND kind = 'resolves' LIMIT 1`)
      .get(id);
    return !!row;
  }

  // -------------------------------------------------------------------------
  // 0.0.6 — milestones
  // -------------------------------------------------------------------------

  putMilestone(m: Milestone): void {
    this.db
      .prepare(
        `INSERT INTO milestones (id, status, title, started_at, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status     = excluded.status,
           title      = excluded.title,
           data       = excluded.data`
      )
      .run(m.id, m.status, m.title, m.startedAt, JSON.stringify(m));
  }

  getMilestone(id: MilestoneId): Milestone | null {
    const row = this.db.prepare(`SELECT data FROM milestones WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Milestone) : null;
  }

  allMilestones(): Milestone[] {
    const rows = this.db
      .prepare(`SELECT data FROM milestones ORDER BY started_at, id`)
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Milestone);
  }

  byMilestoneStatus(status: MilestoneStatus): Milestone[] {
    const rows = this.db
      .prepare(`SELECT data FROM milestones WHERE status = ? ORDER BY started_at, id`)
      .all(status) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Milestone);
  }

  // -------------------------------------------------------------------------
  // 0.0.6 — sessions
  // -------------------------------------------------------------------------

  putSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, milestone_id, source, source_sess_id, started_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           milestone_id    = excluded.milestone_id,
           source          = excluded.source,
           source_sess_id  = excluded.source_sess_id,
           data            = excluded.data`
      )
      .run(s.id, s.milestoneId, s.source, s.sourceSessionId ?? null, s.startedAt, JSON.stringify(s));
  }

  getSession(id: SessionId): Session | null {
    const row = this.db.prepare(`SELECT data FROM sessions WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  // Find an existing Session by the tool's native session id. The dedup key
  // is (source, sourceSessionId) — same Claude Code session reusing across
  // multiple captures collapses to one Session row.
  findSession(source: SessionSource, sourceSessionId: string): Session | null {
    const row = this.db
      .prepare(`SELECT data FROM sessions WHERE source = ? AND source_sess_id = ? LIMIT 1`)
      .get(source, sourceSessionId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Session) : null;
  }

  sessionsInMilestone(id: MilestoneId): Session[] {
    const rows = this.db
      .prepare(`SELECT data FROM sessions WHERE milestone_id = ? ORDER BY started_at, id`)
      .all(id) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Session);
  }

  // -------------------------------------------------------------------------
  // 0.0.6 — decisions × milestones/sessions
  // -------------------------------------------------------------------------

  decisionsInSession(id: SessionId): Decision[] {
    const rows = this.db
      .prepare(`SELECT data FROM decisions WHERE session_id = ? ORDER BY created_at, id`)
      .all(id) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }

  decisionsInMilestone(id: MilestoneId): Decision[] {
    // Two-step: collect session ids, then collect decisions. Cheaper than a
    // multi-table join through json_extract for small Ns.
    const sessionIds = (this.db
      .prepare(`SELECT id FROM sessions WHERE milestone_id = ?`)
      .all(id) as { id: string }[]).map((r) => r.id);
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT data FROM decisions WHERE session_id IN (${placeholders}) ORDER BY created_at, id`)
      .all(...sessionIds) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }

  // Decisions with no sessionId (legacy / unscoped capture).
  unscopedDecisions(): Decision[] {
    const rows = this.db
      .prepare(`SELECT data FROM decisions WHERE session_id IS NULL ORDER BY created_at, id`)
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Decision);
  }
}
