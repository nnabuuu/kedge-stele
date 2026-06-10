// Trace page — decision provenance neighborhood at /<slug>/d/<m>/<id>.
//
// Phase 4 (0.2.0-snapshot.4) will implement this against
// design/Stele Trace.html:
//   - decision picker chip strip
//   - focal card (id/state/tag pills, large serif title)
//   - stitch band (if cross-session)
//   - lifecycle arc with stage dots
//   - neighbors grouped by relation
//   - affects list
//
// Backed by GET /<slug>/api/decisions/<id> (exists, returns Trace),
// GET /<slug>/api/decisions/<id>/stitch (new).

export async function render(root, ctx) {
  const did = ctx.params?.did ?? "";
  const mid = ctx.params?.mid ?? "";
  root.innerHTML = `
    <section class="placeholder">
      <div class="eyebrow">Trace</div>
      <h1>${escapeHtml(mid)} / ${escapeHtml(did)}</h1>
      <p>Phase 4 · coming in 0.2.0-snapshot.4</p>
      <p class="hint">Will render the decision neighborhood + cross-session
        stitch from <code>design/Stele Trace.html</code>.</p>
    </section>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}
