#!/usr/bin/env node
// Thin wrapper so the `stele` bin works under any Node ≥22.6 and on Windows
// (npm's bin shim doesn't read shebang flags). Re-execs Node with the
// type-stripping flags and hands stdio through unchanged.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "src", "cli.ts");

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
