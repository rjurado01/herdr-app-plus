import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { filterFiles } from "../mods/changes-plus/file-filter.js";

test("filters full paths case-insensitively without changing the source", () => {
  const files = [{ path: "src/Example.js" }, { path: "test/example.test.js" }, { path: "README.md" }];
  deepStrictEqual(filterFiles(files, "EXAMPLE"), files.slice(0, 2));
  deepStrictEqual(filterFiles(files, "src/"), [files[0]]);
  deepStrictEqual(filterFiles(files, "missing"), []);
  strictEqual(filterFiles(files, ""), files);
});
