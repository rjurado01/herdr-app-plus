import { test } from "node:test";
import { strict as assert } from "node:assert";
import { columnOffset, orderedRange, selectedOffsets, selectedText, wordRange } from "../mods/changes-plus/text-selection.js";
import { commentReference } from "../mods/changes-plus/comment-reference.js";

const point = (index, offset) => ({ index, offset });
const selection = (anchor, focus, extra = {}) => ({ anchor, focus, split: false, ...extra });

test("copies only selected characters, without diff markers or line numbers", () => {
  const rows = [{ text: "const name = 1;" }];
  assert.equal(selectedText(selection(point(0, 6), point(0, 10)), rows), "name");
  assert.equal(selectedText(selection(point(0, 10), point(0, 6)), rows), "name");
});

test("multiline selection normalizes reverse drags and retains partial endpoints", () => {
  const s = selection(point(2, 2), point(0, 2));
  assert.deepEqual(orderedRange(s), [point(0, 2), point(2, 2)]);
  assert.deepEqual(selectedOffsets(s, 1, 5), [0, 5]);
  assert.equal(selectedOffsets(s, 3, 5), null);
  assert.equal(selectedText(s, [{ text: "first" }, { text: "middle" }, { text: "last" }]), "rst\nmiddle\nla");
});

test("split selection copies only its column, including empty opposite rows", () => {
  const rows = [{ left: { text: "before" }, right: { text: "after" } }, { right: { text: "added" } }];
  const s = selection(point(0, 1), point(1, 3), { split: true, side: "right" });
  assert.equal(selectedText(s, rows), "fter\nadd");
  assert.equal(selectedText({ ...s, side: "left" }, rows), "efore");
});

test("clicking without dragging selects no text", () => {
  assert.equal(selectedText(selection(point(0, 2), point(0, 2)), [{ text: "abc" }]), "");
  assert.equal(selectedText(null, []), "");
});

test("pointer columns map tabs, wide characters and surrogate pairs to source offsets", () => {
  assert.equal(columnOffset("abc", 1.4), 1);
  assert.equal(columnOffset("abc", 1.6), 2);
  assert.equal(columnOffset("\tname", 4), 1);
  assert.equal(columnOffset("a\tb", 4), 2);
  assert.equal(columnOffset("中x", 2), 1);
  assert.equal(columnOffset("😀x", 2), 2);
  assert.equal(columnOffset("abc", 999), 3);
});

test("double click selects a word, spaces or punctuation", () => {
  assert.deepEqual(wordRange("const hello_world = 1", 8), [6, 17]);
  assert.deepEqual(wordRange("a   b", 2), [1, 4]);
  assert.deepEqual(wordRange("a === b", 3), [2, 5]);
});

test("comment references retain exactly the selected text and correct old-side numbers", () => {
  const rows = [{ left: { old: 5, next: 7, text: "before" }, right: { next: 7, text: "after" } }];
  const reference = commentReference({ path: "file.js", layout: "text", split: true, side: "left", start: 0, end: 0, excerpt: "fore" }, [], rows);
  assert.match(reference, /versión anterior, líneas 5-5/);
  assert.match(reference, /```\nfore\n```/);
  assert.ok(!reference.includes("after"));
});
