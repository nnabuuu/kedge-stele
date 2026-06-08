#!/usr/bin/env node
// Build pipeline for `npm run build` and `prepublishOnly`.
//
// Three stages:
//   1. tsc — transpile src/*.ts → dist/*.js (exit code 1 on type errors but
//      we tolerate that as long as files were emitted; noEmitOnError:false)
//   2. copy src/templates/ → dist/templates/ (tsc doesn't carry non-TS)
//   3. chmod +x dist/cli.js + dist/mcp.js (npm bin needs exec perms)
//
// Hard fail only if dist/cli.js or dist/mcp.js is missing after tsc — that
// means a real catastrophic failure, not a type-check warning.
import { spawnSync } from "node:child_process";
import { cpSync, chmodSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const dist = join(repoRoot, "dist");

// Clean dist/ so stale files don't linger across renames
if (existsSync(dist)) rmSync(dist, { recursive: true });

// 1. tsc
console.log("→ tsc");
const tsc = spawnSync(
  "node",
  [join(repoRoot, "node_modules/typescript/bin/tsc")],
  { cwd: repoRoot, stdio: "inherit" },
);
if (tsc.status !== 0) {
  console.warn(`  tsc exited ${tsc.status} — continuing if dist/ was emitted (type errors are non-blocking per tsconfig)`);
}

// Hard-fail if the two bin entries didn't make it through
for (const f of ["cli.js", "mcp.js"]) {
  if (!existsSync(join(dist, f))) {
    console.error(`✗ dist/${f} missing after tsc — real build failure`);
    process.exit(1);
  }
}

// 2. copy templates
console.log("→ copy src/templates → dist/templates");
cpSync(join(repoRoot, "src/templates"), join(dist, "templates"), { recursive: true });

// 3. chmod bin entries
console.log("→ chmod +x dist/cli.js dist/mcp.js");
chmodSync(join(dist, "cli.js"), 0o755);
chmodSync(join(dist, "mcp.js"), 0o755);

console.log("✓ build complete");
