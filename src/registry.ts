// Global stele project registry — the source of truth for the multi-tenant
// daemon's "which projects do I serve" list. Lives at ~/.stele/registry.json.
//
// Each entry maps a unique URL slug (`/kedge-stele/`) to an absolute path on
// disk (`/Users/niex/Documents/GitHub/kedge-stele`). The HTTP server reads
// this on startup and on every registry-mtime change to keep its routing
// table in sync.
//
// CLI commands (`stele list`, `stele serve` in single-project mode, MCP)
// continue to use paths.ts's cwd walk-up — they don't go through the
// registry. The registry is daemon-only state.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ProjectEntry {
  slug: string;
  path: string;        // absolute, canonical
  addedAt: string;     // ISO timestamp
}

export interface Registry {
  version: 1;
  projects: ProjectEntry[];
}

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

export function registryPath(): string {
  return join(homedir(), ".stele", "registry.json");
}

function registryDir(): string {
  return dirname(registryPath());
}

// -----------------------------------------------------------------------------
// Load / save
// -----------------------------------------------------------------------------

const EMPTY_REGISTRY: Registry = { version: 1, projects: [] };

export function loadRegistry(): Registry {
  const path = registryPath();
  if (!existsSync(path)) return { ...EMPTY_REGISTRY, projects: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ...EMPTY_REGISTRY, projects: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_REGISTRY, projects: [] };
    const projects = Array.isArray((parsed as Registry).projects)
      ? (parsed as Registry).projects.filter(
          (p): p is ProjectEntry =>
            !!p && typeof p === "object" &&
            typeof p.slug === "string" &&
            typeof p.path === "string",
        )
      : [];
    return { version: 1, projects };
  } catch {
    // Corrupt JSON — refuse silently rather than throwing into the daemon.
    return { ...EMPTY_REGISTRY, projects: [] };
  }
}

export function saveRegistry(r: Registry): void {
  mkdirSync(registryDir(), { recursive: true });
  const path = registryPath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  // Atomic on POSIX, replace-by-rename
  renameSync(tmp, path);
}

export function registryMtimeMs(): number {
  const path = registryPath();
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// -----------------------------------------------------------------------------
// Slug generation
// -----------------------------------------------------------------------------

export function slugify(input: string): string {
  // input is typically a basename; collapse to URL-safe ascii.
  let s = input.toLowerCase();
  // Replace anything that isn't a-z, 0-9, or hyphen with hyphens
  s = s.replace(/[^a-z0-9-]+/g, "-");
  // Collapse multiple hyphens
  s = s.replace(/-+/g, "-");
  // Trim leading/trailing hyphens
  s = s.replace(/^-+|-+$/g, "");
  if (s.length === 0) s = "project";
  return s;
}

function uniquifySlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("could not generate unique slug — registry too full?");
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

export interface RegisterResult {
  slug: string;
  isNew: boolean;
  entry: ProjectEntry;
}

/** Register a project path. Idempotent on path. Returns the slug. */
export function register(projectPath: string): RegisterResult {
  const abs = resolve(projectPath);
  const r = loadRegistry();
  // Path-idempotency: if this exact path is already registered, return it.
  const existing = r.projects.find((p) => p.path === abs);
  if (existing) return { slug: existing.slug, isNew: false, entry: existing };

  const baseSlug = slugify(basename(abs) || "project");
  const taken = new Set(r.projects.map((p) => p.slug));
  const slug = uniquifySlug(baseSlug, taken);

  const entry: ProjectEntry = { slug, path: abs, addedAt: new Date().toISOString() };
  r.projects.push(entry);
  saveRegistry(r);
  return { slug, isNew: true, entry };
}

/** Remove a project by slug or by path. Returns true if anything was removed. */
export function unregister(slugOrPath: string): boolean {
  const r = loadRegistry();
  const before = r.projects.length;
  const target = resolve(slugOrPath);
  r.projects = r.projects.filter((p) => p.slug !== slugOrPath && p.path !== target);
  if (r.projects.length === before) return false;
  saveRegistry(r);
  return true;
}

export function findBySlug(slug: string): ProjectEntry | null {
  const r = loadRegistry();
  return r.projects.find((p) => p.slug === slug) ?? null;
}

export function findByPath(projectPath: string): ProjectEntry | null {
  const abs = resolve(projectPath);
  const r = loadRegistry();
  return r.projects.find((p) => p.path === abs) ?? null;
}

export function allProjects(): ProjectEntry[] {
  return loadRegistry().projects.slice();
}
