import { DatabaseSync } from "node:sqlite";
import type {
  Decision,
  DecisionId,
  Edge,
  EntityRef,
  Milestone,
  MilestoneId,
  MilestoneStatus,
  ProposalOutcome,
  Session,
  SessionId,
  SessionSource,
  Status,
  StatusKind,
  Tag,
  TagId,
  TagProposal,
  TagStatus,
  Tagging,
  TaggingTargetKind,
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

    // 0.0.7 — enable WAL for better concurrent read perf and crash safety.
    // No-op for :memory: DBs; idempotent for file DBs.
    try {
      this.db.exec(`PRAGMA journal_mode = WAL`);
    } catch {
      // :memory: rejects WAL; fall back to default journal mode
    }

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

      -- 0.0.7 — tag system
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
        target_kind TEXT NOT NULL CHECK(target_kind IN ('milestone','decision')),
        target_id   TEXT NOT NULL,
        PRIMARY KEY (tag_id, target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_taggings_target ON taggings(target_kind, target_id);

      CREATE TABLE IF NOT EXISTS tag_proposals (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        suggested_color TEXT,
        reason          TEXT,
        targets         TEXT NOT NULL,        -- JSON array
        outcome         TEXT NOT NULL CHECK(outcome IN ('pending','blocked','auto_adopted')),
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_outcome ON tag_proposals(outcome);
      -- Loose dedup index: one open pending proposal per (name, outcome). We
      -- enforce idempotency in code rather than via UNIQUE because outcomes
      -- can repeat across name + history.
      CREATE INDEX IF NOT EXISTS idx_proposals_name ON tag_proposals(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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

  // Allocate the next free `M-NN` id. Centralised here so the MCP server,
  // CLI, and any future call sites agree on the contract.
  nextMilestoneId(): MilestoneId {
    const pattern = /^M-(\d+)$/;
    let max = 0;
    for (const m of this.allMilestones()) {
      const r = m.id.match(pattern);
      if (r) {
        const n = Number(r[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return `M-${String(max + 1).padStart(2, "0")}`;
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

  // -------------------------------------------------------------------------
  // 0.0.7 — tags
  // -------------------------------------------------------------------------

  putTag(t: Tag): Tag {
    this.db
      .prepare(
        `INSERT INTO tags (id, name, color, kind, origin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           color      = excluded.color,
           kind       = excluded.kind,
           status     = excluded.status`
      )
      .run(t.id, t.name, t.color, t.kind ?? "scope", t.origin, t.status, t.createdAt);
    return t;
  }

  getTag(id: TagId): Tag | null {
    const row = this.db
      .prepare(`SELECT id, name, color, kind, origin, status, created_at FROM tags WHERE id = ?`)
      .get(id) as
      | { id: string; name: string; color: string; kind: string; origin: TagStatus; status: TagStatus; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      kind: row.kind,
      origin: row.origin as Tag["origin"],
      status: row.status,
      createdAt: row.created_at,
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
      id: row.id,
      name: row.name,
      color: row.color,
      kind: row.kind,
      origin: row.origin as Tag["origin"],
      status: row.status,
      createdAt: row.created_at,
    };
  }

  allTags(status?: TagStatus): Tag[] {
    const sql = status
      ? `SELECT id, name, color, kind, origin, status, created_at FROM tags WHERE status = ? ORDER BY name COLLATE NOCASE`
      : `SELECT id, name, color, kind, origin, status, created_at FROM tags ORDER BY name COLLATE NOCASE`;
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as Array<{
      id: string; name: string; color: string; kind: string; origin: string; status: TagStatus; created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id, name: r.name, color: r.color, kind: r.kind,
      origin: r.origin as Tag["origin"], status: r.status, createdAt: r.created_at,
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

  // -------------------------------------------------------------------------
  // 0.0.7 — taggings (tag ↔ milestone|decision M:N)
  // -------------------------------------------------------------------------

  upsertTagging(tag: Tagging): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO taggings (tag_id, target_kind, target_id) VALUES (?, ?, ?)`,
      )
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

  // -------------------------------------------------------------------------
  // 0.0.7 — tag proposals (pending queue)
  // -------------------------------------------------------------------------

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

  // Merge new targets into an existing pending/blocked proposal for the same
  // name, or insert a fresh one. Idempotency: same (name, outcome) collapses.
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
    if (!existing) {
      return this.putTagProposal(p);
    }
    // Merge target sets (dedup by kind+id)
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
      .prepare(
        `SELECT id, name, suggested_color, reason, targets, outcome, created_at
         FROM tag_proposals WHERE id = ?`,
      )
      .get(id) as
      | { id: string; name: string; suggested_color: string | null; reason: string | null; targets: string; outcome: ProposalOutcome; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      suggestedColor: row.suggested_color ?? undefined,
      reason: row.reason ?? undefined,
      targets: JSON.parse(row.targets) as { kind: TaggingTargetKind; id: string }[],
      outcome: row.outcome,
      createdAt: row.created_at,
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
      id: r.id,
      name: r.name,
      suggestedColor: r.suggested_color ?? undefined,
      reason: r.reason ?? undefined,
      targets: JSON.parse(r.targets) as { kind: TaggingTargetKind; id: string }[],
      outcome: r.outcome,
      createdAt: r.created_at,
    }));
  }

  deleteTagProposal(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM tag_proposals WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  // -------------------------------------------------------------------------
  // 0.0.7 — config key/value (local machine preferences)
  // -------------------------------------------------------------------------

  setConfig(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
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
}
