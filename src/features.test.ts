// Tests for the Feature entity in the 0.1.0 store. Covers CRUD,
// per-project scoping, and the auto-created unscoped feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";

const AT = "2026-06-09T00:00:00Z";

function bootProject(s: Store): string {
  const pid = s.nextProjectId();
  s.putProject({ id: pid, name: "x", path: "/x", status: "active", createdAt: AT });
  return pid;
}

test("putFeature + getFeature roundtrips", () => {
  const s = new Store(":memory:");
  const projectId = bootProject(s);
  const id = s.nextFeatureId();
  s.putFeature({ id, projectId, name: "CcaaS" });
  const f = s.getFeature(id)!;
  assert.equal(f.name, "CcaaS");
});

test("featuresIn scopes to project", () => {
  const s = new Store(":memory:");
  const p1 = bootProject(s);
  const p2id = s.nextProjectId();
  s.putProject({ id: p2id, name: "y", path: "/y", status: "active", createdAt: AT });
  s.putFeature({ id: "F-01", projectId: p1, name: "A" });
  s.putFeature({ id: "F-02", projectId: p2id, name: "B" });
  assert.equal(s.featuresIn(p1).length, 1);
  assert.equal(s.featuresIn(p2id).length, 1);
});

test("ensureUnscopedFeature is idempotent and bound to project id", () => {
  const s = new Store(":memory:");
  const pid = bootProject(s);
  const f1 = s.ensureUnscopedFeature(pid);
  const f2 = s.ensureUnscopedFeature(pid);
  assert.equal(f1.id, f2.id);
  assert.equal(f1.name, "unscoped");
  assert.equal(f1.projectId, pid);
  assert.equal(s.featuresIn(pid).length, 1);
});

test("nextFeatureId increments", () => {
  const s = new Store(":memory:");
  const pid = bootProject(s);
  assert.equal(s.nextFeatureId(), "F-01");
  s.putFeature({ id: "F-01", projectId: pid, name: "A" });
  s.putFeature({ id: "F-02", projectId: pid, name: "B" });
  assert.equal(s.nextFeatureId(), "F-03");
});

test("Feature with links roundtrips", () => {
  const s = new Store(":memory:");
  const pid = bootProject(s);
  s.putFeature({
    id: "F-01", projectId: pid, name: "A",
    links: [{ to: "F-02", relation: "depends-on" }],
  });
  assert.deepEqual(s.getFeature("F-01")!.links, [{ to: "F-02", relation: "depends-on" }]);
});
