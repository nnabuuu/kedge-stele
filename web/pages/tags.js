// Tags page — tag library at /<slug>/tags.
//
// Phase 5 (0.2.0-snapshot.5) will implement this against
// design/Stele Tags.html:
//   - intro
//   - policy panel (auto / propose / locked + require-reason toggle)
//   - pending proposal queue (adopt / reject / rename)
//   - active library (sortable rows: swatch, name, kind, origin, count)
//   - archived collapsible
//
// All backend endpoints already exist (GET /<slug>/api/tags,
// /<slug>/api/tags/proposals, /<slug>/api/config; POST equivalents).

export async function render(root, ctx) {
  root.innerHTML = `
    <section class="placeholder">
      <div class="eyebrow">Tags</div>
      <h1>标签</h1>
      <p>Phase 5 · coming in 0.2.0-snapshot.5</p>
      <p class="hint">Will render the tag policy panel + pending proposal
        queue + active/archived library from
        <code>design/Stele Tags.html</code>.</p>
    </section>
  `;
}
