import { test } from "node:test";
import { strict as assert } from "node:assert";
import { commentReference } from "../mods/changes-plus/comment-reference.js";

test("inline reference orders reverse selections and removes control characters", () => {
  const rows = [{ next: 8, text: "one" }, { next: 9, text: "two\x1b[201~" }];
  const reference = commentReference({ path: "a.js", layout: "inline", side: "next", start: 9, end: 8 }, rows, []);
  assert.match(reference, /versión nueva, líneas 8-9/);
  assert.match(reference, /8: one\n9: two\[201~/);
  assert.ok(!reference.includes("\x1b"));
});

test("split reference includes both columns and rejects crossing a hunk", () => {
  const paired = [{ kind: "pair", left: { old: 1, text: "old" }, right: { next: 1, text: "new" } }, { kind: "@" }];
  assert.match(commentReference({ path: "x", layout: "split", start: 0, end: 0 }, [], paired), /Antes:\n1: old\n\nDespués:\n1: new/);
  assert.throws(() => commentReference({ path: "x", layout: "split", start: 0, end: 1 }, [], paired));
});

test("inline reference refuses missing lines", () => {
  assert.throws(() => commentReference({ path: "x", layout: "inline", side: "old", start: 1, end: 3 }, [{ old: 1, text: "x" }], []));
});
