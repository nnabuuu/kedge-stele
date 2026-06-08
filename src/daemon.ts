// stele daemon installer — keeps the multi-tenant `stele serve --multi`
// running across reboots. The daemon reads ~/.stele/registry.json and routes
// HTTP requests by URL slug to the corresponding project's .stele/decisions.db.
//
// macOS:  ~/Library/LaunchAgents/com.stele.daemon.plist (launchd)
// Linux:  ~/.config/systemd/user/stele-daemon.service   (systemd user)
// Other:  unsupported.
//
// One Label per machine. Multiple projects share the daemon — there's no
// per-project plist/unit anymore. `install` cleans up legacy per-project
// units from earlier snapshots and registers their working directories
// into the global registry, so no data goes missing in the UI.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as netCreateServer } from "node:net";
import { register as registerProject } from "./registry.ts";

// -----------------------------------------------------------------------------
// Identity + paths
// -----------------------------------------------------------------------------

const MAC_LABEL = "com.stele.daemon";
const LINUX_UNIT = "stele-daemon.service";

function macPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function linuxUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", LINUX_UNIT);
}

function logPaths(): { out: string; err: string } {
  return {
    out: join(homedir(), ".stele", "daemon.log"),
    err: join(homedir(), ".stele", "daemon.err.log"),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveLaunchInvocation(): { node: string; nodeFlags: string[]; script: string } {
  const script = process.argv[1] || "stele";
  const isTypescript = script.endsWith(".ts");
  return {
    node: process.execPath,
    nodeFlags: isTypescript ? ["--experimental-strip-types", "--no-warnings"] : [],
    script,
  };
}

function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netCreateServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

function renderPlist(opts: {
  invocation: ReturnType<typeof resolveLaunchInvocation>;
  port: number;
}): string {
  const { invocation, port } = opts;
  const { out, err } = logPaths();
  const programArgs = [
    invocation.node,
    ...invocation.nodeFlags,
    invocation.script,
    "serve",
    "--multi",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
  ];
  const argsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(MAC_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(out)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(err)}</string>
</dict>
</plist>
`;
}

function renderSystemdUnit(opts: {
  invocation: ReturnType<typeof resolveLaunchInvocation>;
  port: number;
}): string {
  const { invocation, port } = opts;
  const { out, err } = logPaths();
  const exec = [
    invocation.node,
    ...invocation.nodeFlags,
    invocation.script,
    "serve",
    "--multi",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
  ].join(" ");
  return `[Unit]
Description=Stele multi-tenant daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${homedir()}
ExecStart=${exec}
Restart=on-failure
RestartSec=3
StandardOutput=append:${out}
StandardError=append:${err}

[Install]
WantedBy=default.target
`;
}

// -----------------------------------------------------------------------------
// Legacy cleanup — sweep pre-0.0.3 per-project plists/units away
// -----------------------------------------------------------------------------

function readWorkingDirFromPlist(plistPath: string): string | null {
  try {
    const xml = readFileSync(plistPath, "utf8");
    // Find <key>WorkingDirectory</key> ... <string>VALUE</string>
    const m = xml.match(/<key>\s*WorkingDirectory\s*<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readWorkingDirFromSystemdUnit(unitPath: string): string | null {
  try {
    const text = readFileSync(unitPath, "utf8");
    const m = text.match(/^\s*WorkingDirectory\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

interface LegacySweep {
  removed: string[];        // labels/unit names cleared
  registered: string[];     // project paths registered into the global registry
}

function sweepLegacyMacOS(): LegacySweep {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) return { removed: [], registered: [] };
  const removed: string[] = [];
  const registered: string[] = [];
  const uid = process.getuid?.() ?? 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("com.stele.")) continue;
    if (name === `${MAC_LABEL}.plist`) continue;
    const label = name.replace(/\.plist$/, "");
    const plistPath = join(dir, name);
    const wd = readWorkingDirFromPlist(plistPath);
    if (wd) {
      try {
        const res = registerProject(wd);
        if (res.isNew) registered.push(res.entry.path);
      } catch {
        // ignore registration failures — cleanup is more important
      }
    }
    spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
    try {
      rmSync(plistPath);
      removed.push(label);
    } catch {
      // best-effort
    }
  }
  return { removed, registered };
}

function sweepLegacyLinux(): LegacySweep {
  const dir = join(homedir(), ".config", "systemd", "user");
  if (!existsSync(dir)) return { removed: [], registered: [] };
  const removed: string[] = [];
  const registered: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("stele-") || !name.endsWith(".service")) continue;
    if (name === LINUX_UNIT) continue;
    const unitPath = join(dir, name);
    const wd = readWorkingDirFromSystemdUnit(unitPath);
    if (wd) {
      try {
        const res = registerProject(wd);
        if (res.isNew) registered.push(res.entry.path);
      } catch {
        // ignore
      }
    }
    spawnSync("systemctl", ["--user", "disable", "--now", name], { stdio: "ignore" });
    try {
      rmSync(unitPath);
      removed.push(name);
    } catch {
      // best-effort
    }
  }
  if (removed.length > 0) {
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
  return { removed, registered };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export type InstallResult = {
  platform: "darwin" | "linux";
  unitPath: string;
  invocation: string;
  port: number;
  loaded: boolean;
  legacy: LegacySweep;
  notes: string[];
};

export async function installDaemon(opts: {
  port?: number;
  printUnit?: boolean;
}): Promise<InstallResult> {
  const port = opts.port ?? 3939;
  const invocation = resolveLaunchInvocation();
  const invocationStr = `${invocation.node} ${invocation.nodeFlags.join(" ")} ${invocation.script}`.trim();
  const notes: string[] = [];

  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `daemon install is not supported on ${process.platform}. ` +
        `Run \`stele serve --multi\` in a terminal multiplexer (tmux/screen) instead.`,
    );
  }

  // Ensure registry/log dir exists.
  ensureDir(join(homedir(), ".stele"));

  if (process.platform === "darwin") {
    const plistPath = macPlistPath();
    const content = renderPlist({ invocation, port });

    if (opts.printUnit) {
      process.stdout.write(content);
      return {
        platform: "darwin",
        unitPath: plistPath,
        invocation: invocationStr,
        port,
        loaded: false,
        legacy: { removed: [], registered: [] },
        notes: ["dry-run: plist printed, not written"],
      };
    }

    // Sweep legacy per-project plists BEFORE the port check — they may be the
    // ones holding 3939. After bootout, give launchd a moment to release.
    const legacy = sweepLegacyMacOS();
    if (legacy.removed.length > 0) {
      notes.push(`cleaned up ${legacy.removed.length} legacy plist(s): ${legacy.removed.join(", ")}`);
      // brief wait so the freed port is observable on the next check
      await new Promise((r) => setTimeout(r, 250));
    }
    if (legacy.registered.length > 0)
      notes.push(`registered ${legacy.registered.length} previously-orphaned project(s) into the global registry`);

    // Now the port check — after legacy cleanup
    const free = await portFree(port);
    if (!free) {
      throw new Error(
        `port ${port} is already bound on 127.0.0.1 — pass a different --port`,
      );
    }

    ensureDir(dirname(plistPath));
    writeFileSync(plistPath, content);
    notes.push(`wrote ${plistPath}`);

    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}`;
    // bootout any previous version of this same Label (idempotent re-install)
    spawnSync("launchctl", ["bootout", `${target}/${MAC_LABEL}`], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["bootstrap", target, plistPath], { encoding: "utf8" });
    const loaded = r.status === 0;
    if (loaded) notes.push("launchctl bootstrap succeeded — loaded");
    else notes.push(`launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.status}`}`);

    return {
      platform: "darwin",
      unitPath: plistPath,
      invocation: invocationStr,
      port,
      loaded,
      legacy,
      notes,
    };
  }

  // Linux — systemd user unit.
  const unitPath = linuxUnitPath();
  const content = renderSystemdUnit({ invocation, port });

  if (opts.printUnit) {
    process.stdout.write(content);
    return {
      platform: "linux",
      unitPath,
      invocation: invocationStr,
      port,
      loaded: false,
      legacy: { removed: [], registered: [] },
      notes: ["dry-run: unit printed, not written"],
    };
  }

  const legacy = sweepLegacyLinux();
  if (legacy.removed.length > 0) {
    notes.push(`cleaned up ${legacy.removed.length} legacy unit(s): ${legacy.removed.join(", ")}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (legacy.registered.length > 0)
    notes.push(`registered ${legacy.registered.length} previously-orphaned project(s) into the global registry`);

  const free = await portFree(port);
  if (!free) {
    throw new Error(
      `port ${port} is already bound on 127.0.0.1 — pass a different --port`,
    );
  }

  ensureDir(dirname(unitPath));
  writeFileSync(unitPath, content);
  notes.push(`wrote ${unitPath}`);

  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  const r = spawnSync(
    "systemctl",
    ["--user", "enable", "--now", LINUX_UNIT],
    { encoding: "utf8" },
  );
  const loaded = r.status === 0;
  if (loaded) notes.push("systemctl --user enable --now succeeded");
  else notes.push(`systemctl --user enable --now failed: ${r.stderr.trim() || `exit ${r.status}`}`);

  notes.push(
    `Note: services run only while you're logged in. For true always-on, ` +
      `consider \`sudo loginctl enable-linger ${process.env.USER || "$USER"}\`.`,
  );

  return { platform: "linux", unitPath, invocation: invocationStr, port, loaded, legacy, notes };
}

export function uninstallDaemon(): { notes: string[] } {
  const notes: string[] = [];

  if (process.platform === "darwin") {
    const plistPath = macPlistPath();
    const uid = process.getuid?.() ?? 0;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${MAC_LABEL}`], { stdio: "ignore" });
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      notes.push(`removed ${plistPath}`);
    } else {
      notes.push(`${plistPath} not present`);
    }
  } else if (process.platform === "linux") {
    const unitPath = linuxUnitPath();
    spawnSync("systemctl", ["--user", "disable", "--now", LINUX_UNIT], {
      stdio: "ignore",
    });
    if (existsSync(unitPath)) {
      rmSync(unitPath);
      notes.push(`removed ${unitPath}`);
    } else {
      notes.push(`${unitPath} not present`);
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } else {
    notes.push(`${process.platform} unsupported — nothing to do`);
  }

  return { notes };
}

export type StatusResult = {
  platform: NodeJS.Platform;
  unitPresent: boolean;
  unitPath: string;
  loaded: boolean;
  loadedNote: string;
};

export function daemonStatus(): StatusResult {
  if (process.platform === "darwin") {
    const plistPath = macPlistPath();
    const unitPresent = existsSync(plistPath);
    const r = spawnSync("launchctl", ["list", MAC_LABEL], { encoding: "utf8" });
    const loaded = r.status === 0;
    return {
      platform: "darwin",
      unitPresent,
      unitPath: plistPath,
      loaded,
      loadedNote: loaded ? r.stdout.split("\n")[0] || "loaded" : "not loaded",
    };
  }
  if (process.platform === "linux") {
    const unitPath = linuxUnitPath();
    const unitPresent = existsSync(unitPath);
    const r = spawnSync(
      "systemctl",
      ["--user", "is-active", LINUX_UNIT],
      { encoding: "utf8" },
    );
    const loaded = r.status === 0 && r.stdout.trim() === "active";
    return {
      platform: "linux",
      unitPresent,
      unitPath,
      loaded,
      loadedNote: r.stdout.trim() || `exit ${r.status}`,
    };
  }
  return {
    platform: process.platform,
    unitPresent: false,
    unitPath: "(unsupported platform)",
    loaded: false,
    loadedNote: "unsupported",
  };
}
