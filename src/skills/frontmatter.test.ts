import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";

test("external skills support folded and literal multiline descriptions", () => {
  const folded = parseFrontmatter(
    "---\nname: release-kit\ndescription: >-\n  Prepare a release\n  and check the result.\nmetadata:\n  name: not-the-skill-name\n---\nInstructions remain separate.\n",
  );
  assert.equal(folded?.frontmatter.name, "release-kit");
  assert.equal(folded?.frontmatter.description, "Prepare a release and check the result.");
  assert.equal(folded?.body, "Instructions remain separate.\n");
  const literal = parseFrontmatter(
    "---\nname: literal\ndescription: |\n  First line\n  Second line\n---\nBody\n",
  );
  assert.equal(literal?.frontmatter.description, "First line\nSecond line");
});

test("quoted descriptions round-trip apostrophes, quotes and newlines", () => {
  const fm = { name: "quoted", description: 'Lisa\'s "release" workflow\nsecond line' };
  assert.equal(
    parseFrontmatter(buildFrontmatter(fm, "Body"))?.frontmatter.description,
    fm.description,
  );
  const single = parseFrontmatter(
    "---\nname: single\ndescription: 'Lisa''s workflow'\n---\nBody\n",
  );
  assert.equal(single?.frontmatter.description, "Lisa's workflow");
});
