# P13: natural-usage extraction and generated-candidate loop

Frozen on 2026-08-05 before running P13.

P12 evaluates a supplied candidate against structured usage decisions. P13
tests two previously omitted interfaces: extracting those decisions from
natural utterances and inducing candidate descriptions from teaching examples.

## Usage extraction

- Every P12 development and test observation is rendered with one of four
  fixed dialogue templates (two affirmative, two rejecting).
- Qwen2.5-1.5B predicts whether the speaker applies the novel word.
- An extraction threshold is selected on development utterances only and then
  frozen for test. Report test AUC, accuracy, sensitivity, and specificity.

## Candidate induction and gate

- On the 90 unseen G1--G3 test items, Qwen2.5-1.5B receives only the teaching
  examples and samples four concise candidate definitions.
- Candidate strings are cleaned mechanically; no oracle semantic parser or
  ground-truth meaning is used by the gate.
- Six automatic placebo descriptions are made from the first generated
  candidate using fixed transformations. The transformations do not inspect M.
- Candidate predictive gain is computed using labels extracted from the
  natural utterances. The selected candidate is the generated candidate with
  largest placebo-z. It is admitted only if it exceeds P12's already-frozen
  threshold z > 1.1428607599918683; P13 does not retune that threshold.
- Evaluation may use the constructed true usage labels, but only after the
  gate has selected and admitted a candidate.

## Outcomes

1. Natural-usage extraction quality on the unseen test set.
2. Coverage: fraction of test items for which a generated candidate is admitted.
3. Beneficial-admission precision: fraction of admitted candidates whose true
   held-out NLL is lower than the no-definition baseline.
4. Mean true held-out gain for (a) the first generated candidate (write-all),
   (b) the best generated candidate selected by the gate, and (c) the oracle
   best of the four generated candidates.
5. Selection regret relative to the oracle best candidate.

This is an interface stress test, not a natural-conversation benchmark: the
underlying objects and meanings remain procedurally generated, and the dialogue
templates contain explicit applications or rejections.

## Post-hoc robustness (not part of the frozen primary test)

After observing the primary run, repeat candidate sampling with seeds 20260806
and 20260807. Reuse the frozen extraction and admission thresholds and report
each seed separately. These runs quantify decoding sensitivity and are never
pooled with, or presented as confirmation of, the frozen primary run.
