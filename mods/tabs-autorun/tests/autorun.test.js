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
