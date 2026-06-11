// Shared resume-command builder. Both adapters — mcp.ts `resume_command` and
// serve.ts `/api/sessions/:id/resume-command` — emit the same
// `cd <cwd> && claude --resume <id>` string that the USER copies into their
// shell. Both `cwd` and the cc session id flow in unvalidated from
// decision_capture and /stele:scan (third-party transcripts), so every value
// crossing into the command must be shell-quoted, and an id that isn't a real
// resumable session must not be advertised as runnable.

// POSIX single-quote: bare-safe strings pass through; anything else is wrapped
// in '...' with embedded single-quotes escaped. This is the quoting the sibling
// adapters previously applied only to cwd (and not to the id).
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// A real, resumable cc session id (UUID-ish). Composite ids minted by
// /stele:scan ("<uuid>#F-01") and empty/unknown ids fail this — they're shown
// but not offered as copy-and-run.
const RESUMABLE_SID = /^[A-Za-z0-9._-]+$/;

export function isResumableSessionId(id: string | undefined | null): boolean {
  return !!id && RESUMABLE_SID.test(id);
}

export function resumeCommand(cwd: string, ccSid: string): string {
  return `cd ${shQuote(cwd || ".")} && claude --resume ${shQuote(ccSid)}`;
}
