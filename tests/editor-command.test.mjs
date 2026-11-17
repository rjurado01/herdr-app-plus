import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseEditorCommand, editorCommand } from "../mods/changes-plus/editor-command.js";

test("substitutes a path without shell expansion or recursive placeholders", () => {
  const args = parseEditorCommand('["code", "--goto", "{archivo}:{linea}"]');
  assert.deepEqual(editorCommand(args, "/tmp/a {linea}; touch x", 7), ["code", "--goto", "/tmp/a {linea}; touch x:7"]);
});

test("rejects malformed commands and requires a file placeholder", () => {
  for (const input of ["code foo", "[]", '["", "{archivo}"]', '["code"]', '["code", 2, "{archivo}"]'])
    assert.throws(() => parseEditorCommand(input));
});

test("defaults an absent line to one", () => {
  assert.deepEqual(editorCommand(["editor", "{archivo}:{linea}"], "/tmp/a b", null), ["editor", "/tmp/a b:1"]);
});
