import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRules, targetForClick } from "../autorun.js";

const rules = validateRules([{ name: "OpenCode", command: "opencode" }, { name: "Vim", command: "nvim" }]);
const pane = { tab: "t1", terminal: "t7", program: { shell: true } };

test("only the clicked tab's terminal is selected, including other spaces", () => {
  const result = targetForClick({ id: "another", machine: null }, { id: "t1", named: true, name: "Vim" }, [pane, { ...pane, tab: "other" }], rules);
  assert.deepEqual(result, { terminal: "t7", command: "nvim" });
});

test("other names, occupied terminals and multiple panes do nothing", () => {
  const space = { id: "s" }, tab = { id: "t1", named: true, name: "OpenCode" };
  assert.equal(targetForClick(space, { ...tab, name: "Opencode" }, [pane], rules), null);
  assert.equal(targetForClick(space, tab, [{ ...pane, program: { shell: false } }], rules), null);
  assert.equal(targetForClick(space, tab, [pane, { ...pane, terminal: "t8" }], rules), null);
  assert.equal(targetForClick(space, { ...tab, named: false }, [pane], rules), null);
});

test("invalid and duplicate rules are rejected", () => {
  assert.throws(() => validateRules([{ name: "Vim", command: "nvim\nx" }]));
  assert.throws(() => validateRules([{ name: "Vim", command: "a" }, { name: "Vim", command: "b" }]));
});

test("a named space overrides the global rule and other spaces use the default", () => {
  const configured = validateRules([
    { name: "Vim", command: "nvim" },
    { space: "work", name: "Vim", command: "vim" },
    { space: "personal", name: "Vim", command: "vi" },
  ]);
  const tab = { id: "t1", named: true, name: "Vim" };
  assert.equal(targetForClick({ named: true, name: "work" }, tab, [pane], configured).command, "vim");
  assert.equal(targetForClick({ named: true, name: "personal" }, tab, [pane], configured).command, "vi");
  assert.equal(targetForClick({ named: true, name: "other" }, tab, [pane], configured).command, "nvim");
  assert.equal(targetForClick({ named: false, name: "work" }, tab, [pane], configured).command, "nvim");
  assert.throws(() => validateRules([{ space: "work", name: "Vim", command: "x" }, { space: "work", name: "Vim", command: "y" }]));
});

test("old rules without space remain global", () => {
  const old = validateRules([{ name: "Vim", command: "nvim" }]);
  assert.equal(targetForClick({ named: true, name: "work" }, { id: "t1", named: true, name: "Vim" }, [pane], old).command, "nvim");
});
