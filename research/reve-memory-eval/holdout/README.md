# Cross-session holdout protocol

The item author works from the task description without inspecting the implementation or earlier model outputs. Two disjoint batches each contain four correction tasks and four grounding tasks. Each item specifies separate conversations, an initial memory, the facts that must survive, assertions to detect stale or unsupported facts, and a natural-language grading rubric. Freeze both files before the first model request. Keep confirmation item text and results out of implementation work until the candidate is committed.

## Paired runs

- Discovery compares the full pre-grounding checkout at `3345b13` with the merged implementation at `429ef5b`. Diagnose misses using this batch only.
- Confirmation compares `429ef5b` with the committed repair. Both arms receive identical input and the same requested model. Record the model reported by the service. Each arm gets a fresh home for each item. Alternate which arm runs first.
- Write the prior and current conversations as separate sessions. Seed the initial memory and invoke the normal reflector on **only the last session**. Earlier conversations stay on disk and are available to the product's own retrieval. This measures consolidation after a gap in reflection, independently of whether an earlier background pass would have saved an intermediate note.
- One run per item and arm. Keep unsuccessful outputs. Report network or provider failures separately and preserve completed paid calls on retry. Exclude an incomplete pair from comparative quality claims. An unparseable completed response is a quality failure.
- Evaluate the two persistent memory stores after the run. For corrections require the new fact to be active in the intended store, all protected facts preserved and the old fact retired. An explicitly historical value is acceptable if it cannot be mistaken for the current fact. For grounding, check the person, scope, attribution and certainty of every newly stored claim. A confusing or stale note and a novel unsupported claim are recorded separately. No-change fixtures require the original memory to remain intact.
- Keep the automatic assertions alongside a separate semantic grading pass. Inspect **all** new persisted claims, including claims the item author did not anticipate. Use only the supplied conversations and initial state as evidence. Grade each batch without architecture labels. Record disagreements with the matched rules.
- Report correction passes, grounding passes, trials with unsupported writes (all valid trials as denominator), requests, and input, output, cache-read and cache-write tokens. Add the four mutually exclusive token categories for total consumption. Cache duration subcategories are part of cache writes. Totals measure tokens and do not estimate the bill.

Independent PR review identified an unmarked-legacy-channel ambiguity and an overlapping-session timing hazard in the first candidate. A **third disjoint eight-item publication batch** was frozen at `6e70c0a` before measuring the revised product at `0e76081`. Publication compares that revision against `429ef5b`. It uses native headers from each measured checkout's session writer, plus a deliberately unmarked legacy transcript and an external-channel transcript. Frozen fixture times establish ordering. The last session is loaded from disk in all three batches.

The batches answer different comparisons. Neither batch is pooled with the earlier development set. The unit of observation is one synthetic scenario per arm. A holdout used to guide a further repair becomes diagnostic and must be labeled accordingly.

## Run and verify

The [evaluation report](../../../docs/REVE_CROSS_SESSION_HOLDOUT_2026-11-08.md) links the three raw ledgers and their anonymous-grading audits. Each measured checkout needs the project's dependencies. Run from the checkout containing this harness, using full checkouts of the named commits and a fresh output filename.

```sh
node --import tsx research/reve-memory-eval/holdout/run.ts --fixtures=research/reve-memory-eval/holdout/confirmation.json --left=../before-fix --right=../candidate --output=/tmp/reve-confirmation-recheck.json --model=claude-sonnet-4-6 --jobs=3
node --import tsx research/reve-memory-eval/holdout/run.ts --fixtures=research/reve-memory-eval/holdout/publication.json --left=../before-fix --right=../owner-fix --output=/tmp/reve-publication-recheck.json --model=claude-sonnet-4-6 --sessions=native --jobs=3
node research/reve-memory-eval/holdout/verify.mjs
```

Both run.ts commands consume real model tokens. The verifier runs offline, checks fixture hashes, paired coverage, response model and recorded request counts, and recomputes the published aggregates.
