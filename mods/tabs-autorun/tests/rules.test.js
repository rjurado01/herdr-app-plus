import test from "node:test";
import assert from "node:assert/strict";
import { missingTabs } from "../rules.js";

const space = { id: "s", name: "vm", named: true, machine: null, tabs: [{ name: "Vim" }] };

test("only plans missing tabs, in configured order", () => {
  assert.deepEqual(missingTabs([space], { vm: [{ name: "Vim" }, { name: "OpenCode" }, { name: "Console" }] }), [
    { space: "s", name: "OpenCode" }, { space: "s", name: "Console" },
  ]);
});
test("ignores unnamed, remote and unconfigured spaces", () => {
  assert.deepEqual(missingTabs([{ ...space, named: false }, { ...space, id: "remote", machine: "vps" }], { vm: [{ name: "X" }] }), []);
  assert.deepEqual(missingTabs([space], {}), []);
});
test("does not guess on duplicate spaces or invalid and duplicate rules", () => {
  assert.deepEqual(missingTabs([space, { ...space, id: "s2" }], { vm: [{ name: "X" }] }), []);
  assert.deepEqual(missingTabs([space], { vm: [{ name: "X" }, { name: "X" }] }), []);
  assert.deepEqual(missingTabs([space], { vm: [{ name: "" }] }), []);
});
test("preserves exact case and does not mutate state", () => {
  const before = structuredClone(space);
  assert.deepEqual(missingTabs([space], { vm: [{ name: "vim" }] }), [{ space: "s", name: "vim" }]);
  assert.deepEqual(space, before);
});
