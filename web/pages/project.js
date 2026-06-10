// Project page — single-project landing at /<slug>/.
//
// Phase 3 (0.2.0-snapshot.3) will implement this against
// design/Stele Project.html:
//   - sticky topbar with breadcrumbs
//   - left feature rail
//   - main: milestone header + resume strip + session timeline +
//     decision chips per session row
//
// Backed by GET /<slug>/api/project (exists), GET /<slug>/api/feature-rail
// (new), GET /<slug>/api/timeline?feature=<id> (new).

export async function render(root, ctx) {
  root.innerHTML = `
    <section class="placeholder">
      <div class="eyebrow">Project · ${escapeHtml(ctx.slug ?? "")}</div>
      <h1>单项目视图</h1>
      <p>Phase 3 · coming in 0.2.0-snapshot.3</p>
      <p class="hint">Will render feature rail + milestone × session
        timeline + decision chips from
        <code>design/Stele Project.html</code>.</p>
    </section>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}
