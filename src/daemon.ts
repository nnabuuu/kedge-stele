// stele daemon installer — keeps `stele serve` running across reboots so the
// browser URL is always alive (the point of having a UI in the first place).
//
// macOS:  writes ~/Library/LaunchAgents/com.stele.<hash>.plist + launchctl bootstrap
// Linux:  writes ~/.config/systemd/user/stele-<hash>.service + systemctl --user
// Other:  unsupported (Windows, etc.) — caller gets a clear error.
//
// `<hash>` is the first 8 hex chars of sha256(projectRoot), so multiple
// projects each get their own daemon.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as netCreateServer } from "node:net";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// Identity + paths
// -----------------------------------------------------------------------------

function projectHash(projectRoot: string): string {
  return createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 8);
}

function macPlistPath(hash: string): string {
  return join(homedir(), "Library", "LaunchAgents", `com.stele.${hash}.plist`);
}

function macLabel(hash: string): string {
  return `com.stele.${hash}`;
}

function linuxUnitPath(hash: string): string {
  return join(homedir(), ".config", "systemd", "user", `stele-${hash}.service`);
}

function linuxUnitName(hash: string): string {
  return `stele-${hash}.service`;
}

function logPaths(projectRoot: string): { out: string; err: string } {
  return {
    out: join(projectRoot, ".stele", "serve.log"),
    err: join(projectRoot, ".stele", "serve.err.log"),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Resolve the exact invocation launchd/systemd should use. We can't rely on
// the `stele` bin shim because it uses `#!/usr/bin/env node` — daemon
// environments have a stripped-down PATH (no asdf/nvm), so the shebang fails.
// Instead, write absolute node + script path with the TypeScript-strip flags
// inline. process.execPath is the live node binary; process.argv[1] is the
// src/cli.ts the current invocation resolved to.
function resolveLaunchInvocation(): { node: string; nodeFlags: string[]; script: string } {
  return {
    node: process.execPath,
    nodeFlags: ["--experimental-strip-types", "--no-warnings"],
    script: process.argv[1] || "src/cli.ts",
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
  hash: string;
  invocation: ReturnType<typeof resolveLaunchInvocation>;
  projectRoot: string;
  port: number;
}): string {
  const { hash, invocation, projectRoot, port } = opts;
  const { out, err } = logPaths(projectRoot);
  const programArgs = [
    invocation.node,
    ...invocation.nodeFlags,
    invocation.script,
    "serve",
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
  <string>${escapeXml(macLabel(hash))}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(projectRoot)}</string>
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
  projectRoot: string;
  port: number;
}): string {
  const { invocation, projectRoot, port } = opts;
  const { out, err } = logPaths(projectRoot);
  const exec = [
    invocation.node,
    ...invocation.nodeFlags,
    invocation.script,
    "serve",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
  ].join(" ");
  return `[Unit]
Description=Stele serve for ${projectRoot}
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
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
// Public API
// -----------------------------------------------------------------------------

export type InstallResult = {
  platform: "darwin" | "linux";
  unitPath: string;
  invocation: string;
  port: number;
  loaded: boolean;
  notes: string[];
};

export async function installDaemon(opts: {
  projectRoot: string;
  port: number;
  printUnit?: boolean;
}): Promise<InstallResult> {
  const projectRoot = resolve(opts.projectRoot);
  const port = opts.port;
  const invocation = resolveLaunchInvocation();
  const invocationStr = `${invocation.node} ${invocation.nodeFlags.join(" ")} ${invocation.script}`;
  const hash = projectHash(projectRoot);
  const notes: string[] = [];

  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `daemon install is not supported on ${process.platform}. ` +
        `Run \`stele serve\` in a terminal multiplexer (tmux/screen) instead.`,
    );
  }

  // Port-conflict guard. Skip for print-only dry runs.
  if (!opts.printUnit) {
    const free = await portFree(port);
    if (!free) {
      throw new Error(
        `port ${port} is already bound on 127.0.0.1 — pass a different --port`,
      );
    }
  }

  // Ensure log directory exists (in the project's .stele/).
  ensureDir(join(projectRoot, ".stele"));

  if (process.platform === "darwin") {
    const plistPath = macPlistPath(hash);
    const content = renderPlist({ hash, invocation, projectRoot, port });

    if (opts.printUnit) {
      process.stdout.write(content);
      return {
        platform: "darwin",
        unitPath: plistPath,
        invocation: invocationStr,
        port,
        loaded: false,
        notes: ["dry-run: plist printed, not written"],
      };
    }

    ensureDir(dirname(plistPath));
    writeFileSync(plistPath, content);
    notes.push(`wrote ${plistPath}`);

    // launchctl bootstrap. If a previous version is loaded, bootout first
    // (idempotent install) and ignore failures.
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}`;
    spawnSync("launchctl", ["bootout", `${target}/${macLabel(hash)}`], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["bootstrap", target, plistPath], { encoding: "utf8" });
    const loaded = r.status === 0;
    if (loaded) notes.push(`launchctl bootstrap succeeded → loaded`);
    else notes.push(`launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.status}`}`);

    return { platform: "darwin", unitPath: plistPath, invocation: invocationStr, port, loaded, notes };
  }

  // Linux — systemd user unit.
  const unitPath = linuxUnitPath(hash);
  const content = renderSystemdUnit({ invocation, projectRoot, port });

  if (opts.printUnit) {
    process.stdout.write(content);
    return {
      platform: "linux",
      unitPath,
      invocation: invocationStr,
      port,
      loaded: false,
      notes: ["dry-run: unit printed, not written"],
    };
  }

  ensureDir(dirname(unitPath));
  writeFileSync(unitPath, content);
  notes.push(`wrote ${unitPath}`);

  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  const r = spawnSync(
    "systemctl",
    ["--user", "enable", "--now", linuxUnitName(hash)],
    { encoding: "utf8" },
  );
  const loaded = r.status === 0;
  if (loaded) notes.push(`systemctl --user enable --now succeeded`);
  else notes.push(`systemctl --user enable --now failed: ${r.stderr.trim() || `exit ${r.status}`}`);

  notes.push(
    `Note: services run only while you're logged in. For true always-on, ` +
      `consider \`sudo loginctl enable-linger ${process.env.USER || "$USER"}\`.`,
  );

  return { platform: "linux", unitPath, invocation: invocationStr, port, loaded, notes };
}

export function uninstallDaemon(projectRoot: string): { notes: string[] } {
  const root = resolve(projectRoot);
  const hash = projectHash(root);
  const notes: string[] = [];

  if (process.platform === "darwin") {
    const plistPath = macPlistPath(hash);
    const uid = process.getuid?.() ?? 0;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${macLabel(hash)}`], { stdio: "ignore" });
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      notes.push(`removed ${plistPath}`);
    } else {
      notes.push(`${plistPath} not present`);
    }
  } else if (process.platform === "linux") {
    const unitPath = linuxUnitPath(hash);
    spawnSync("systemctl", ["--user", "disable", "--now", linuxUnitName(hash)], {
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

export function daemonStatus(projectRoot: string): StatusResult {
  const root = resolve(projectRoot);
  const hash = projectHash(root);

  if (process.platform === "darwin") {
    const plistPath = macPlistPath(hash);
    const unitPresent = existsSync(plistPath);
    const r = spawnSync("launchctl", ["list", macLabel(hash)], { encoding: "utf8" });
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
    const unitPath = linuxUnitPath(hash);
    const unitPresent = existsSync(unitPath);
    const r = spawnSync(
      "systemctl",
      ["--user", "is-active", linuxUnitName(hash)],
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
