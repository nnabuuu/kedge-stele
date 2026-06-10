// Decision Graph page — interactive viewer at /<slug>/graph.
//
// Phase 6 (0.2.0-snapshot.6) will implement this against
// design/Decision Graph.html:
//   - feature rail navigation
//   - phase pills with status dots
//   - main: phase-panel card OR full feature-map (drag-pan)
//   - loose-ends rail on right
//
// Backed by GET /<slug>/api/graph?feature=&milestone=&tag= (new
// projection — graphSlice).

export async function render(root, ctx) {
  root.innerHTML = `
    <section class="placeholder">
      <div class="eyebrow">Decision Graph</div>
      <h1>决策图</h1>
      <p>Phase 6 · coming in 0.2.0-snapshot.6</p>
      <p class="hint">Will render the interactive decision graph from
        <code>design/Decision Graph.html</code> against the new
        <code>graphSlice</code> projection.</p>
    </section>
  `;
}
