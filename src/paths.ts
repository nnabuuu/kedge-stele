// Single source of truth for where the stele (decision store) lives.
//
// Resolution order (first match wins):
//   1. STELE_DB env (or legacy PROV_DB) — explicit override, escape hatch.
//   2. Walk up from cwd looking for an existing `.stele/` marker dir, stopping
//      at $HOME (inclusive only when cwd IS $HOME). Found → use
//      `<that-dir>/.stele/decisions.db`. This is the project-based default:
//      `stele init` once at the project root, every subdirectory under it
//      sees the same store.
//   3. Otherwise: error with a clear hint to run `stele init`. We deliberately
//      do NOT auto-create — explicit beats implicit, and a silent .stele/ in
//      the wrong cwd is a real footgun in the npm-installed distribution.
//
// $HOME boundary: the walk does NOT cross $HOME from a subdirectory. So a
// project at `~/projects/foo/` never accidentally picks up `~/.stele/`. If
// you explicitly want the global view, `cd ~ && stele init` (or pass STELE_DB).
//
// Don't hardcode any other path elsewhere (the "别写死任何绝对路径——这是个
// 真踩过的坑" rule from ProductDesign).
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

import { t } from "./i18n.ts";

function findSteleRoot(start: string, home: string): string | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".stele");
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return dir;
      } catch {
        // unreadable — treat as absent
      }
    }
    if (dir === home) return null;
    const parent = dirname(dir);
    if (parent === dir || parent === home) return null;
    dir = parent;
  }
}

export class SteleNotInitializedError extends Error {
  constructor(cwd: string) {
    super(t("cli.errors.no_stele_store", { cwd }));
    this.name = "SteleNotInitializedError";
  }
}

export function resolveDbPath(): string {
  const override = process.env.STELE_DB ?? process.env.PROV_DB;
  if (override) return override;

  const home = homedir();
  const cwd = process.cwd();

  const found = findSteleRoot(cwd, home);
  if (found) return join(found, ".stele", "decisions.db");

  throw new SteleNotInitializedError(cwd);
}
