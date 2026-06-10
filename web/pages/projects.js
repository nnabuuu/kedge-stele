// Projects page — multi-project overview at /.
//
// Phase 2 (0.2.0-snapshot.2) will fully implement this against
// design/Stele Projects.html:
//   - sticky topbar with global search + tags-link + "+ new project"
//   - global resume strip (latest active milestone + alive/rebuild launcher)
//   - sortable project grid (recent / due / loops + density toggle)
//   - collapsible chip for dormant / archived
//
// For now we render a placeholder so the shell + router are end-to-end
// verifiable.

export async function render(root, ctx) {
  root.innerHTML = `
    <section class="placeholder">
      <div class="eyebrow">Projects</div>
      <h1>多项目入口</h1>
      <p>Phase 2 · coming in 0.2.0-snapshot.2</p>
      <p class="hint">Will render the multi-project overview from
        <code>design/Stele Projects.html</code> against the extended
        <code>GET /api/projects</code> response.</p>
    </section>
  `;
}
