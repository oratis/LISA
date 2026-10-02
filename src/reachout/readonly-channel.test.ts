/**
 * The read-only proactive channel (charter §1.4, §8).
 *
 * Lisa's unattended runs — idle reflection / Reve, desire heartbeats, the
 * scheduled desire review — may read, and may write her own soul, memory,
 * skills and knowledge base. They may not send, publish, execute or write
 * outside her home. That boundary is `autonomousSubset` (a BLOCK list) and
 * `desireReviewSubset` (an allow list) in src/tools/registry.ts.
 *
 * Because `autonomousSubset` is a block list, a tool added to the registry is
 * available to unattended runs by default. This test pins the exact set, so
 * adding a tool fails here until someone classifies it below. A tool that can
 * act outward must go into AUTONOMOUS_BLOCKED_TOOL_NAMES instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTONOMOUS_BLOCKED_TOOL_NAMES,
  autonomousSubset,
  buildToolRegistry,
  desireReviewSubset,
} from "../tools/registry.js";
import { autonomyProfileForEdition, toolsForCapabilityProfile } from "../web/capabilities.js";

/**
 * read   — observes only (files, the web, agent/session state, her own soul).
 * self   — writes, but only inside Lisa's home (soul, memory, skills, KB).
 * device — acts on the local machine without sending, publishing, running
 *          arbitrary code or writing files. Each one is justified inline.
 */
type Reach = "read" | "self" | "device";

const AUTONOMOUS_ALLOWED: Record<string, Reach> = {
  advise_now: "read",
  agent_recap: "read",
  dispatch_status: "read",
  github_link: "read", // builds a URL from the local repo; opens nothing
  grep: "read",
  inspect_agent: "read",
  kb_links: "read",
  kb_list: "read",
  kb_read: "read",
  kb_search: "read",
  list_agents: "read",
  ls: "read",
  memory_search: "read",
  npm_info: "read",
  pr_status: "read",
  read: "read",
  repo_digest: "read",
  review_diff: "read",
  soul_diff: "read",
  soul_history: "read",
  soul_read: "read",
  web_fetch: "read", // HTTP GET only
  web_search: "read",

  desire_close: "self",
  desire_progress_log: "self",
  desire_revise: "self",
  kb_add: "self",
  kb_ingest: "self", // fetch → KB; unattended runs are limited to the feeds watchlist
  kb_write: "self",
  memory: "self",
  set_mood: "self",
  skill_manage: "self",
  soul_feel: "self",
  soul_journal: "self",
  soul_object: "self",
  soul_patch: "self",

  // Runs the fixed `/usr/bin/say` binary on text: audible on this Mac, reaches no one else.
  speak: "device",
  // Uploads a local audio file to the transcription provider and returns text.
  // It transmits user data to a third party, so it is the weakest entry here —
  // kept because it is what the subset contains today; see the PR notes.
  transcribe: "device",
};

/** Names that mean "this acts on the world". None may appear in an unattended subset. */
const OUTWARD = [
  "bash",
  "write",
  "edit",
  "apply_patch",
  "redeploy",
  "task",
  "dispatch_agent",
  "run_on_plan",
  "signal_agent",
  "scheduled_dispatch",
  "compare_agents",
  "run_checks",
  "github",
  "mcp",
  "social_compose",
  "takoapi",
];

const DESIRE_REVIEW_ALLOWED: Record<string, Reach> = {
  desire_close: "self",
  desire_progress_log: "self",
  desire_revise: "self",
  soul_journal: "self",
  soul_read: "read",
  web_fetch: "read",
  web_search: "read",
};

function withoutEscapeHatch<T>(fn: () => T): T {
  const prev = process.env.LISA_AUTONOMOUS_FULL_TOOLS;
  delete process.env.LISA_AUTONOMOUS_FULL_TOOLS;
  try {
    return fn();
  } finally {
    if (prev !== undefined) process.env.LISA_AUTONOMOUS_FULL_TOOLS = prev;
  }
}

const registry = () => buildToolRegistry({ includeVoice: true });
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name).sort();

test("autonomousSubset is exactly the classified read/self set — a new tool must be classified", () => {
  withoutEscapeHatch(() => {
    const actual = names(autonomousSubset(registry()));
    const expected = Object.keys(AUTONOMOUS_ALLOWED).sort();
    const unclassified = actual.filter((n) => !(n in AUTONOMOUS_ALLOWED));
    assert.deepEqual(
      unclassified,
      [],
      `unattended runs can now call ${unclassified.join(", ")} — block it in ` +
        `AUTONOMOUS_BLOCKED_TOOL_NAMES, or classify it in readonly-channel.test.ts if it only ` +
        `reads or writes inside Lisa's home`,
    );
    assert.deepEqual(actual, expected);
  });
});

test("no unattended subset contains a tool that sends, publishes, executes or writes outside home", () => {
  withoutEscapeHatch(() => {
    const all = registry();
    const subsets: Record<string, string[]> = {
      autonomous: names(autonomousSubset(all)),
      "desire-review": names(desireReviewSubset(all)),
      "mac-autonomy-profile": names(
        autonomousSubset(toolsForCapabilityProfile(all, autonomyProfileForEdition("mac"))),
      ),
      "cloud-autonomy-profile": names(
        autonomousSubset(toolsForCapabilityProfile(all, autonomyProfileForEdition("cloud"))),
      ),
    };
    for (const [label, subset] of Object.entries(subsets)) {
      for (const name of OUTWARD) {
        assert.ok(!subset.includes(name), `${label} subset exposes outward tool "${name}"`);
      }
      for (const name of subset) {
        assert.ok(
          name in AUTONOMOUS_ALLOWED,
          `${label} subset exposes unclassified tool "${name}"`,
        );
      }
    }
  });
});

test("every outward tool in the registry is on the autonomous block list", () => {
  const registered = new Set(registry().map((t) => t.name));
  for (const name of OUTWARD) {
    assert.ok(
      AUTONOMOUS_BLOCKED_TOOL_NAMES.has(name),
      `${name} must stay blocked for unattended runs`,
    );
  }
  // And the reverse: nothing on the block list is quietly classified as allowed.
  for (const name of AUTONOMOUS_BLOCKED_TOOL_NAMES) {
    assert.ok(!(name in AUTONOMOUS_ALLOWED), `${name} is both blocked and classified allowed`);
  }
  // The block list and the allow table together account for the whole registry.
  const unaccounted = [...registered].filter(
    (n) => !AUTONOMOUS_BLOCKED_TOOL_NAMES.has(n) && !(n in AUTONOMOUS_ALLOWED),
  );
  assert.deepEqual(unaccounted, []);
});

test("the desire-review subset is exactly its seven read/self tools", () => {
  const actual = names(desireReviewSubset(registry()));
  assert.deepEqual(actual, Object.keys(DESIRE_REVIEW_ALLOWED).sort());
  for (const name of actual) assert.notEqual(DESIRE_REVIEW_ALLOWED[name], "device");
});

test("the only non-read, non-self entries are the two documented device tools", () => {
  const device = Object.entries(AUTONOMOUS_ALLOWED)
    .filter(([, reach]) => reach === "device")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(device, ["speak", "transcribe"]);
});
