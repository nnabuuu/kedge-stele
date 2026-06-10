// Resume launcher popover — to be implemented in Phase 2.
//
// Behavior per design mocks (Projects, Project, Trace all use this):
//   - Click target opens a popover with alive/rebuild state
//   - Alive: deeplink to last session in Claude Code (jump mode)
//   - Rebuild: copy-paste `claude --resume` command (rebuild mode)
//
// Phase 2 wires this up against GET /<slug>/api/sessions/<id>/resume-command.

export function renderResumeLauncher(_opts = {}) {
  // Stub for Phase 1 — will be implemented in Phase 2.
  return "";
}
