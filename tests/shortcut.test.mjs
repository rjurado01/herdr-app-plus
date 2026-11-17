import test from "node:test";
import assert from "node:assert/strict";
import { changeShortcut, currentShortcut, normalizeShortcut } from "../mods/changes-plus/shortcut.js";

test("replaces only this layout's Changes Plus key", () => {
  const keys = { global: { "alt-g": "tab-host.toggle:better-changes" }, "layout:my": { "alt-g": "changes-plus.toggle", "alt-x": "other" } };
  const result = changeShortcut(keys, "my", "Ctrl-Shift-F8");
  assert.deepEqual(result["layout:my"], { "alt-x": "other", "ctrl-shift-f8": "changes-plus.toggle" });
  assert.equal(result.global["alt-g"], "tab-host.toggle:better-changes");
  assert.equal(currentShortcut(result, "my"), "ctrl-shift-f8");
  assert.equal(currentShortcut(keys, "my"), "alt-g");
});
test("allows keeping an existing binding even when global has the same key", () => {
  const keys = { global: { "alt-g": "legacy" }, "layout:my": { "alt-g": "changes-plus.toggle" } };
  assert.equal(currentShortcut(changeShortcut(keys, "my", "alt-g"), "my"), "alt-g");
});
test("can restore Alt+G without changing the legacy global binding", () => {
  const keys = { global: { "alt-g": "tab-host.toggle:better-changes" }, "layout:my": { "alt-t": "changes-plus.toggle" } };
  const updated = changeShortcut(keys, "my", "alt-g");
  assert.equal(updated.global["alt-g"], "tab-host.toggle:better-changes");
  assert.deepEqual(updated["layout:my"], { "alt-g": "changes-plus.toggle" });
  assert.throws(() => changeShortcut({ ...keys, terminal: { "alt-g": "other" } }, "my", "alt-g"), /ya está asignado/);
});
test("refuses conflicts in global, layout and terminal scopes", () => {
  for (const scope of ["global", "terminal", "layout:other"]) {
    assert.throws(() => changeShortcut({ [scope]: { "shift-ctrl-f8": "other" } }, "my", "ctrl-shift-f8"), /ya está asignado/);
  }
});
test("validates combinations and does not mutate source", () => {
  for (const value of ["g", "alt-", "ctrl-ctrl-g", "weird-g", "alt-escape", ""]) assert.throws(() => normalizeShortcut(value));
  const original = { global: { "alt-g": "thing" } };
  assert.throws(() => changeShortcut(original, "my", "alt-g"));
  assert.deepEqual(original, { global: { "alt-g": "thing" } });
});
