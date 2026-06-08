import { DatabaseSync } from "node:sqlite";
import type { Decision, DecisionId, Edge, EntityRef, Status, StatusKind } from "./types.ts";

// The store owns the graph. It needs NO ontology to answer "which decisions
// touched entity X" — it keeps its own reverse index of affects edges.
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
    `);
  }

  // ---- decisions -----------------------------------------------------------

  putDecision(d: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, status_kind, title, created_at, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status_kind = excluded.status_kind,
           title       = excluded.title,
           data        = excluded.data`
      )
      .run(d.id, d.status.kind, d.title, d.raisedBy.at, JSON.stringify(d));

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
}
