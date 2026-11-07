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

test("a hash inside a value is text, not a comment", () => {
  for (const description of ["Handle PR #12 reviews", "Build C# projects"]) {
    const built = buildFrontmatter({ name: "hash-skill", description }, "Body\n");
    assert.equal(parseFrontmatter(built)?.frontmatter.description, description);
    assert.equal(
      parseFrontmatter(`---\nname: hash-skill\ndescription: ${description}\n---\nBody\n`)
        ?.frontmatter.description,
      description,
    );
  }
  const commented = parseFrontmatter(
    "---\n# a comment line\nname: commented\ndescription: Real\n---\nBody\n",
  );
  assert.equal(commented?.frontmatter.name, "commented");
});

test("folded descriptions turn a blank line into one line break", () => {
  const parsed = parseFrontmatter(
    "---\nname: folded\ndescription: >\n  one\n  more\n\n  two\n\n\n  three\n---\nBody\n",
  );
  assert.equal(parsed?.frontmatter.description, "one more\ntwo\n\nthree");
});
